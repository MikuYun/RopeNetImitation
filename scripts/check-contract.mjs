/**
 * 契约对齐门禁。
 *
 * 拿 backend/openapi.json 反向比对 contracts/requirements/*.json，
 * 做三类机械检查：
 *
 *   (a) 结构完整性：需求书声明的 path+method 是否都在 openapi 中，成功响应码是否一致
 *   (b) 字段级：把两侧 schema 摊平成「字段路径 → 类型/枚举」集合后逐条比对
 *                  - 请求体：我方多声明字段 = ERROR（后端 additionalProperties:false 会拒绝）
 *                  - 响应体：需求书要的字段缺失 = ERROR（前端会崩）
 *                  - required 不一致 = WARN
 *   (c) 枚举一致性：enum 值集合双向比对
 *                  - openapi 有而我方没有 = ERROR（前端没写这个分支）
 *                  - 我方有而 openapi 没有 = WARN（前端需 default 分支）
 *
 * 用法：
 *   node scripts/check-contract.mjs              # 常规检查，退出码 0/1
 *   node scripts/check-contract.mjs --self-test  # 注入故意缺陷，验证门禁本身有效
 *   node scripts/check-contract.mjs --json       # JSON 输出
 *   node scripts/check-contract.mjs --quiet      # 只输出摘要
 *
 * 退出码：0 = 无 ERROR；1 = 存在 ERROR；2 = 运行错误
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const OPENAPI_PATH = resolve(ROOT, 'backend/openapi.json')
const REQ_DIR = resolve(ROOT, 'contracts/requirements')
const REPORT_PATH = resolve(ROOT, 'docs/contract/check-result.md')

const argv = process.argv.slice(2)
const SELF_TEST = argv.includes('--self-test')
const AS_JSON = argv.includes('--json')
const QUIET = argv.includes('--quiet')

const errors = []
const warnings = []
const stats = { paths: 0, declared: 0, fieldChecks: 0, enumChecks: 0, bodyChecks: 0 }

const err = (scope, msg) => errors.push({ scope, msg })
const warn = (scope, msg) => warnings.push({ scope, msg })

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/* ── 加载 ───────────────────────────────────────────────────────── */

if (!existsSync(OPENAPI_PATH)) {
  console.error(`[check-contract] 找不到 ${OPENAPI_PATH}`)
  console.error('后端尚未产出 openapi.json —— 契约无法比对。')
  process.exit(2)
}

let openapi = readJson(OPENAPI_PATH)
const restReq = readJson(resolve(REQ_DIR, 'rest-requirements.json'))
const wsReq = readJson(resolve(REQ_DIR, 'ws-requirements.json'))
const errReq = readJson(resolve(REQ_DIR, 'errors.json'))

const REQ_DEFS = restReq.definitions ?? {}

/* ── schema 摊平 ────────────────────────────────────────────────── */

/**
 * 把 schema 摊平成 Map<"字段路径", { type, enums, required }>。
 * 路径形如 `items[].members[].lastReadSeq`；根节点路径为 ''。
 *
 * @param schema       待摊平的 schema
 * @param defs         $ref 解析表（需求书用 #/definitions/X；openapi 全内联，传 {} 即可）
 * @param prefix       当前路径前缀
 * @param out          输出 Map
 * @param maxDepth     防御性深度上限（避免循环 $ref 无限递归）。
 *                     注意必须 > 本契约最深嵌套 items[].members[].user.* （深度 9），
 *                     否则 User 子属性会被截断并误报为「openapi 多出必填字段」。
 */
function flatten(schema, defs, prefix, out, maxDepth = 16, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > maxDepth) return

  // $ref 解析
  if (schema.$ref) {
    const key = schema.$ref.split('/').pop()
    const target = defs[key]
    if (target) flatten(target, defs, prefix, out, maxDepth, depth + 1)
    return
  }

  // 组合关键字：同一路径下合并各分支
  for (const kw of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[kw])) {
      for (const sub of schema[kw]) flatten(sub, defs, prefix, out, maxDepth, depth + 1)
    }
  }

  // 数组：路径后缀 []
  if (schema.type === 'array' && schema.items) {
    flatten(schema.items, defs, `${prefix}[]`, out, maxDepth, depth + 1)
    return
  }

  const props = schema.properties
  if (!props || typeof props !== 'object') return

  const required = new Set(schema.required ?? [])

  for (const [name, sub] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name
    const entry = out.get(path) ?? { types: new Set(), enums: null, required: false }
    entry.required = entry.required || required.has(name)
    collectType(sub, entry)
    out.set(path, entry)
    flatten(sub, defs, path, out, maxDepth, depth + 1)
  }
}

/** 收集某个字段自身（不含其子属性）的类型与枚举。 */
function collectType(node, entry) {
  if (!node || typeof node !== 'object') return
  if (node.type) {
    for (const t of Array.isArray(node.type) ? node.type : [node.type]) {
      entry.types.add(t === 'null' ? 'null' : t)
    }
  }
  if (Array.isArray(node.enum)) {
    entry.enums = entry.enums ?? new Set()
    for (const v of node.enum) entry.enums.add(JSON.stringify(v))
  }
  for (const kw of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[kw])) {
      for (const sub of node[kw]) collectType(sub, entry)
    }
  }
}

function flattenSchema(schema, defs) {
  const out = new Map()
  flatten(schema, defs, '', out)
  return out
}

/* ── openapi 路径归一化 ─────────────────────────────────────────── */

/** 后端 path key 已含 /api/v1；需求书也写全路径。两者做双向容忍。 */
function findPathKey(pathValue) {
  if (openapi.paths[pathValue]) return pathValue
  if (openapi.paths[`/api/v1${pathValue}`]) return `/api/v1${pathValue}`
  if (pathValue.startsWith('/api/v1')) {
    const bare = pathValue.slice('/api/v1'.length)
    if (openapi.paths[bare]) return bare
  }
  return null
}

function responseSchema(pathKey, method, status) {
  const op = openapi.paths[pathKey]?.[method]
  if (!op) return null
  return op.responses?.[String(status)]?.content?.['application/json']?.schema ?? null
}

function requestSchema(pathKey, method) {
  const op = openapi.paths[pathKey]?.[method]
  return op?.requestBody?.content?.['application/json']?.schema ?? null
}

/* ── 自检模式：注入故意缺陷 ─────────────────────────────────────── */

if (SELF_TEST) {
  const broken = JSON.parse(JSON.stringify(openapi))
  const keys = Object.keys(broken.paths)

  // 缺陷 1（结构）：删掉一个端点。
  // 注意必须选一个【后面不再被改造】的路径 —— 早期版本这里删的是 /conversations，
  // 而缺陷 2/3 又去改 /conversations，导致路径已不存在、改造静默失效，
  // self-test 因此只能命中 structure 一类，误判为「门禁失效」。改用 /friends。
  const victim = keys.find((k) => k.endsWith('/friends') && k.includes('api/v1'))
  if (victim) delete broken.paths[victim]

  // 缺陷 2（字段）：从会话列表项里删掉 unreadCount
  const listKey = keys.find((k) => k.endsWith('/conversations') && k.includes('api/v1'))
  if (listKey) {
    const s = broken.paths[listKey]?.get?.responses?.['200']?.content?.['application/json']?.schema
    const item = s?.properties?.items?.items
    if (item?.properties) delete item.properties['unreadCount']
  }

  // 缺陷 3（枚举）：把 type 的枚举值改坏
  if (listKey) {
    const s = broken.paths[listKey]?.get?.responses?.['200']?.content?.['application/json']?.schema
    const item = s?.properties?.items?.items
    if (item?.properties?.['type']) item.properties['type'] = { type: 'string', enum: ['directx'] }
  }

  // 缺陷 4（请求体）：给发消息的请求体加一个我方未声明的必填字段
  const sendKey = keys.find((k) => k.endsWith('/messages') && k.includes('api/v1'))
  if (sendKey) {
    const body = broken.paths[sendKey]?.post?.requestBody?.content?.['application/json']?.schema
    if (body?.properties) {
      body.properties['extraRequired'] = { type: 'string' }
      body.required = [...(body.required ?? []), 'extraRequired']
    }
  }

  openapi = broken
  if (!QUIET) {
    console.log('[check-contract] --self-test：已注入 4 处故意缺陷')
    console.log('  (1) 删端点  (2) 删响应字段  (3) 改枚举值  (4) 加请求体必填字段')
    console.log('  预期报出 ≥3 条 ERROR；若不足则说明门禁失效\n')
  }
}

/* ── (a) 结构完整性 ─────────────────────────────────────────────── */

const endpoints = restReq.endpoints ?? []
stats.declared = endpoints.length
stats.paths = Object.keys(openapi.paths).length

const reached = new Set()

for (const ep of endpoints) {
  const method = ep.method.toLowerCase()
  const key = findPathKey(ep.path)
  const label = `${ep.method} ${ep.path}`

  if (!key) {
    const blocking = ep.required !== false
    ;(blocking ? err : warn)('structure', `端点缺失：${label}`)
    continue
  }
  if (!openapi.paths[key][method]) {
    err('structure', `方法缺失：${label}`)
    continue
  }
  reached.add(`${method} ${key}`)

  // 成功响应码
  if (ep.success !== undefined && ep.success !== null) {
    const codes = Object.keys(openapi.paths[key][method].responses ?? {})
    if (!codes.includes(String(ep.success))) {
      err('structure', `${label} 缺少成功响应码 ${ep.success}（openapi 实际：${codes.join(',')}）`)
    }
  }

  // 需求书声明的全部响应码是否都在 openapi 里（204 这类无正文的也要）
  for (const code of ep.responseCodes ?? []) {
    const codes = Object.keys(openapi.paths[key][method].responses ?? {})
    if (!codes.includes(String(code))) {
      warn('structure', `${label} 需求书声明响应码 ${code}，openapi 未列出`)
    }
  }
}

// openapi 有、需求书没有 → 提示补录基准
for (const [p, ops] of Object.entries(openapi.paths)) {
  for (const m of Object.keys(ops)) {
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(m)) continue
    if (!reached.has(`${m} ${p}`)) {
      warn('structure', `需求书未收录：${m.toUpperCase()} ${p}（后端已实现，请补录基准）`)
    }
  }
}

/* ── (b) 响应字段级比对 ─────────────────────────────────────────── */

function compareFields(label, reqSchema, oapiSchema, kind) {
  const reqFields = flattenSchema(reqSchema, REQ_DEFS)
  // openapi 全内联，但它也可能引用自身 definitions（当前没有），传空表即可
  const oapiFields = flattenSchema(oapiSchema, {})

  for (const [path, req] of reqFields) {
    stats.fieldChecks += 1
    const actual = oapiFields.get(path)

    if (!actual) {
      err(kind, `${label} ${kind === 'body' ? '请求体' : '响应'}缺少字段 \`${path}\``)
      continue
    }

    // 类型：忽略 null（可空语义），只比非空类型
    const reqTypes = [...req.types].filter((t) => t !== 'null')
    const actTypes = [...actual.types].filter((t) => t !== 'null')
    if (reqTypes.length > 0 && actTypes.length > 0) {
      const missing = reqTypes.filter((t) => !actTypes.includes(t))
      if (missing.length > 0) {
        err(kind, `${label} 字段 \`${path}\` 类型不符：需求书 ${reqTypes.join('|')}，openapi ${actTypes.join('|')}`)
      }
    }

    // required：需求书要求必填而 openapi 没有 → WARN
    if (req.required && !actual.required) {
      warn(kind, `${label} 字段 \`${path}\` 需求书标为必填，openapi 未声明为 required`)
    }
  }

  // 响应：反向只做 WARN（后端可追加字段，前端需容错）
  // 请求体：反向是 ERROR（后端 additionalProperties:false 会拒绝我方多传的字段）
  for (const [path, actual] of oapiFields) {
    if (reqFields.has(path)) continue
    if (actual.required) {
      const msg = `${label} ${kind === 'body' ? '请求体' : '响应'}多出必填字段 \`${path}\`${kind === 'body' ? '（后端会因 additionalProperties:false 拒绝我方请求）' : '（前端需容错）'}`
      ;(kind === 'body' ? err : warn)(kind, msg)
    } else if (kind === 'body') {
      warn(kind, `${label} 请求体多出可选字段 \`${path}\`（我方未声明，通常无需发送）`)
    }
  }
}

for (const ep of endpoints) {
  const method = ep.method.toLowerCase()
  const key = findPathKey(ep.path)
  if (!key) continue
  const label = `${ep.method} ${ep.path}`

  // 响应
  if (ep.response) {
    const status = ep.success ?? 200
    const oapiRes = responseSchema(key, method, status)
    if (oapiRes) {
      compareFields(label, ep.response, oapiRes, 'response')
    } else if (ep.response !== null) {
      warn('response', `${label} 需求书声明了响应体，但 openapi 未提供 ${status} 的 JSON schema`)
    }
  }

  // 请求体
  if (ep.body) {
    const oapiBody = requestSchema(key, method)
    if (oapiBody) {
      stats.bodyChecks += 1
      compareFields(label, ep.body, oapiBody, 'body')
    } else {
      err('body', `${label} 需求书声明了请求体，但 openapi 未提供 requestBody`)
    }
  }
}

/* ── (c) 枚举一致性（双向） ─────────────────────────────────────── */

for (const ep of endpoints) {
  const method = ep.method.toLowerCase()
  const key = findPathKey(ep.path)
  if (!key || !ep.response) continue
  const label = `${ep.method} ${ep.path}`
  const status = ep.success ?? 200
  const oapiRes = responseSchema(key, method, status)
  if (!oapiRes) continue

  const reqFields = flattenSchema(ep.response, REQ_DEFS)
  const oapiFields = flattenSchema(oapiRes, {})

  for (const [path, req] of reqFields) {
    if (!req.enums) continue
    stats.enumChecks += 1
    const actual = oapiFields.get(path)
    if (!actual?.enums) {
      err('enum', `${label} 字段 \`${path}\` 需求书声明白名单 ${[...req.enums].join('|')}，openapi 无 enum 声明`)
      continue
    }
    for (const v of actual.enums) {
      if (!req.enums.has(v)) {
        err('enum', `${label} 字段 \`${path}\` openapi 有枚举值 ${v}，需求书未收录（前端会崩）`)
      }
    }
    for (const v of req.enums) {
      if (!actual.enums.has(v)) {
        warn('enum', `${label} 字段 \`${path}\` 需求书有枚举值 ${v}，openapi 未实现（前端需 default 分支）`)
      }
    }
  }
}

/* ── 错误体结构 ─────────────────────────────────────────────────── */

if (!errReq.envelope?.properties?.error?.properties?.code) {
  err('error-envelope', 'errors.json 未声明 error.code')
}
if (!errReq.envelope?.properties?.error?.properties?.traceId) {
  warn('error-envelope', 'errors.json 未声明 error.traceId（后端 API.md 声明有此字段）')
}

const probePath = Object.keys(openapi.paths).find((p) => p.includes('/users/me'))
if (probePath) {
  const s = openapi.paths[probePath].get?.responses?.['401']?.content?.['application/json']?.schema
  if (!s) {
    warn('error-envelope', `${probePath} 未声明 401 错误响应`)
  } else {
    const f = flattenSchema(s, {})
    if (!f.has('error')) err('error-envelope', `${probePath} 401 响应缺少 \`error\` 包装`)
    if (!f.has('error.traceId')) {
      warn('error-envelope', `${probePath} 401 的 error 内缺少 \`traceId\``)
    }
  }
}

/* ── 版本一致性 ─────────────────────────────────────────────────── */

const openapiVersion = openapi.info?.version
if (restReq.openapiVersion && restReq.openapiVersion !== openapiVersion) {
  warn('version', `rest-requirements.openapiVersion=${restReq.openapiVersion}，实际=${openapiVersion}`)
}
if (wsReq.openapiVersion && wsReq.openapiVersion !== openapiVersion) {
  warn('version', `ws-requirements.openapiVersion=${wsReq.openapiVersion}，实际=${openapiVersion}`)
}

/* ── 自检断言 ───────────────────────────────────────────────────── */

if (SELF_TEST) {
  const scopes = new Set(errors.map((e) => e.scope))
  const need = ['structure', 'response', 'enum', 'body']
  const hit = need.filter((s) => scopes.has(s))
  const ok = errors.length >= 3 && hit.length >= 3

  console.log(`[check-contract] self-test：ERROR=${errors.length} WARN=${warnings.length}`)
  console.log(`[check-contract] 命中的检查类别：${[...scopes].join(', ') || '(无)'}`)
  console.log('[check-contract] 各类别明细：')
  for (const e of errors) console.log(`    [${e.scope}] ${e.msg}`)
  if (ok) {
    console.log(`\n[check-contract] ✅ 门禁有效（命中 ${hit.join(' / ')}），可检出端点缺失、字段缺失、枚举不一致、请求体多字段\n`)
    process.exit(0)
  }
  console.error(`\n[check-contract] ❌ 门禁失效：仅命中 ${hit.join(' / ') || '无'}，未达预期\n`)
  process.exit(1)
}

/* ── 输出 ───────────────────────────────────────────────────────── */

if (AS_JSON) {
  console.log(JSON.stringify({ openapiVersion, stats, errors, warnings }, null, 2))
} else {
  console.log('=== 契约比对结果 ===')
  console.log(`openapi 版本：${openapiVersion}`)
  console.log(`openapi 路径数：${stats.paths}；需求书声明：${stats.declared}`)
  console.log(
    `字段检查 ${stats.fieldChecks} 项；枚举检查 ${stats.enumChecks} 项；请求体检查 ${stats.bodyChecks} 端点`,
  )
  console.log(`ERROR ${errors.length} / WARN ${warnings.length}`)
  console.log()

  if (errors.length > 0 && !QUIET) {
    console.log('--- ERROR（阻塞）---')
    for (const e of errors) console.log(`  [${e.scope}] ${e.msg}`)
    console.log()
  }
  if (warnings.length > 0 && !QUIET) {
    console.log('--- WARN（非阻塞，需确认）---')
    for (const w of warnings) console.log(`  [${w.scope}] ${w.msg}`)
    console.log()
  }
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ 无差异：需求书与 backend/openapi.json 完全一致')
  }
}

/* ── 写报告 ─────────────────────────────────────────────────────── */

try {
  const lines = [
    '# 契约机械比对结果',
    '',
    '> 本文件由 `scripts/check-contract.mjs` 自动生成，请勿手工编辑。',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- openapi 版本：\`${openapiVersion}\``,
    `- 命令：\`node scripts/check-contract.mjs\``,
    '',
    '## 摘要',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| openapi 路径数 | ${stats.paths} |`,
    `| 需求书声明端点数 | ${stats.declared} |`,
    `| 字段检查项 | ${stats.fieldChecks} |`,
    `| 枚举检查项 | ${stats.enumChecks} |`,
    `| 请求体检查端点 | ${stats.bodyChecks} |`,
    `| **ERROR** | **${errors.length}** |`,
    `| WARN | ${warnings.length} |`,
    '',
  ]
  if (errors.length > 0) {
    lines.push('## ERROR（阻塞）', '')
    for (const e of errors) lines.push(`- \`[${e.scope}]\` ${e.msg}`)
    lines.push('')
  }
  if (warnings.length > 0) {
    lines.push('## WARN（非阻塞）', '')
    for (const w of warnings) lines.push(`- \`[${w.scope}]\` ${w.msg}`)
    lines.push('')
  }
  if (errors.length === 0 && warnings.length === 0) {
    lines.push('✅ 无差异：需求书与 `backend/openapi.json` 完全一致。', '')
  }
  writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8')
  if (!AS_JSON) console.log(`报告已写入 ${REPORT_PATH.replace(ROOT, '.')}`)
} catch (e) {
  console.error('[check-contract] 写报告失败：', e.message)
}

process.exit(errors.length > 0 ? 1 : 0)
