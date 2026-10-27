# OPS 交付证据（OPS-01 / OPS-02 / OPS-03）

> 作者：backend-ops（teammate）
> 实测时间：2026-10-22 11:14–11:40（Asia/Shanghai，本机开发工作站）
> 全部演练均在 `os.tmpdir()` 下的**隔离库**执行，未触碰任何生产库/生产探针，未执行 `git commit`/`git tag`，
> **未执行 `reset-chat.mjs`、未执行 `cleanup-probe.mjs --execute`**。
> 数据均为真实运行输出，未达标/未执行项一律如实标注，无虚构。

---

## 0. 环境与构建指纹

| 项 | 值 |
| --- | --- |
| OS / Shell | Windows 10，Git Bash（`/b/AITrance`） |
| Node | `v24.15.0`（`/e/nodejs/node`） |
| npm | `11.12.1`（必须 `node /e/nodejs/node_modules/npm/bin/npm-cli.js` 调用，bash 直接 `npm` 会报 `'"node"' 不是内部或外部命令`） |
| SQLite | 内置 `node:sqlite`（`DatabaseSync`），模块级 `backup()` 可用；`DatabaseSync` 实例**没有** `.backup()` 方法 → `backup.mjs` 用模块级 `backup()`，失败回退 `VACUUM INTO` |
| 构建命令 | `cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run build` → **退出码 0** |
| 构建时刻 | 2026-10-22 11:40:40（`dist/src/*.js` mtime），构建于 OPS 全部实测**之前**，实测用的就是这套 dist |
| `backend/src/` 聚合 sha256 | `79c6fb825427fcb50255a44ef6d9831e6a0342197ab0911220217e2ac1809eda`（`ls -1 src/*.ts \| sort \| xargs sha256sum \| sha256sum`，10 个 .ts） |
| `backend/dist/src/app.js` sha256 | `d898e643cec364182a5dd979c0d5041c2632ef4e8f6a33267ec41eb66470f89b` |

### 0.1 重要变更说明（非本文档作者改动）

`backend/src/config.ts`、`app.ts`、`realtime.ts`、`server.ts` 在本轮中途被 **backend-core** 修改（新增 SEC-01 TLS / REQUIRE_HTTPS / retention sweep）。本文档记录的是**变更后重建 dist 并全部复跑**的结果，OPS 脚本与新增配置字段兼容：

- `Config` 新增 `tls: TlsPaths | null`、`requireHttps: boolean`、`requireHttpsMode`、`retentionSweepSeconds`（1..3600，默认 30）、`retentionMessageDays`（0..3650，默认 0）；`buildApp()` 返回新增 `transport: 'https' | 'http'`。
- 起 server 后日志实测两行：`{"transport":"http","requireHttps":false,"retentionSweepSeconds":30,"retentionMessageDays":0,"msg":"Chat backend transport: http"}` 与 `{"retention":{"sessions":0,"tickets":0,"messages":0},"trigger":"startup","messageDays":0,"msg":"Retention sweep completed"}`。
- `health-probe.mjs` / `loadtest.mjs` / `restore-drill.mjs` 都通过 `buildApp({ databasePath })` 或对外 HTTP/WS 契约工作，**不需要**为新字段做任何改动，已实测全通过。

### 0.2 交付文件清单（全部在 `backend/ops/`，共 7 个）

| 文件 | 行数 | sha256 | 职责 |
| --- | --- | --- | --- |
| `backend/ops/backup.mjs` | 289 | `62c7520245e0a6f612f672d23e9b79ae05d4775b530331d220d2ef205ef97b35` | OPS-01 一致性备份 |
| `backend/ops/restore-drill.mjs` | 342 | `ce0e83d40bfd678e73796564306b3876892353de868533be513d83055dc44e8a` | OPS-01 备份+恢复演练（RTO/RPO） |
| `backend/ops/loadtest.mjs` | 506 | `6107727639734e25d535dd8c196d1c11e2354339322999d716c0b6cf422e23d7` | OPS-02 负载/容量 |
| `backend/ops/health-probe.mjs` | 330 | `a802e59ede0f02358ee429e15d3d0aac6786dae52703a850118ed1a2b750b7a6` | OPS-02 健康探测 + 阈值告警 |
| `backend/ops/cleanup-probe.mjs` | 360 | `909bc1f49cd9e09f1792750d1988eb8474e230571eb05bb2dd9b6f6f0ed96635` | OPS-03 清理盘点（默认 dry-run） |
| `backend/ops/seed-fixture.mjs` | 278 | `8449b4d690d78cbcdb01ced5bb55b2b4aceb1eaadb5de4f27ea375bf4f7330ef` | OPS-03 dry-run 用的隔离样本库夹具 |
| `backend/ops/alert-drill.md` | 138 | `d3a0c24a41029a34c03f848a99d9cff53c2af6ed1d930c47ded974c02d528705` | OPS-02 告警演练步骤（BLOCK 说明） |

所有脚本均支持 `--help`，均以 stdout JSON 输出结构化报告，退出码语义统一：`0` = 成功/无 CRITICAL，`1` = 检查失败/有 CRITICAL，`2` = 参数或环境错误。

---

## OPS-01 备份与恢复

### OPS-01a `backend/ops/backup.mjs` —— 一致性备份

**命令**（在 `/b/AITrance/backend` 下）：

```bash
node ops/backup.mjs \
  --source "$TEMP/aitrance-ops-final/fixture/fixture.sqlite" \
  --dest   "$TEMP/aitrance-ops-final/fixture/backup.sqlite" \
  --report "$TEMP/aitrance-ops-evidence/backup.json"
echo "exit=$?"
```

**退出码：0**（PASS）

**实测数字**：

| 项 | 实测值 |
| --- | --- |
| 备份方法 | `node:sqlite backup()`（模块级函数，不是 `VACUUM INTO` 回退路径） |
| 耗时 `durationMs` | **11 ms** |
| 备份文件大小 | **114688 bytes** |
| 备份文件 sha256 | `a625c56236c2ad765f1e74512b8524b5b2877cfea664136fc7b1d5dce4425b1c` |
| `PRAGMA integrity_check` | `{"ok":true,"details":["ok"]}` |
| `countsMatch`（源/备逐表相等） | **true** |
| 源库快照 | `userVersion:1`、`journalMode:"wal"`、`users:4, sessions:5, friend_requests:2, friendships:5, conversations:4, conversation_members:8, messages:8, ws_tickets:1`、`maxMessageId:8`、`maxSeq:3` |
| 备份目标分区可用空间 | `destFreePercent: 25.9` |

**关键设计**：源库用 `new DatabaseSync(source, { readOnly: true })` 打开，因此可在**应用仍在写**时在线备份；WAL 中已提交但未 checkpoint 的数据会被包含（OPS-01b 有专项断言证明）。

**修复过的两个 bug（记录以备复查）**：
1. 初版误用 `db.get(sql)`，但 `DatabaseSync` 实例没有 `.get()` → 全部改为 `db.prepare(sql).get()/.all()`。
2. 对不含业务表的库直接 `SELECT COUNT(*) FROM messages` 会抛 `no such table` → 增加 `existingTables()`（查 `sqlite_master`）判断，缺失表的计数记 `null`，不再让整个备份失败。

---

### OPS-01b `backend/ops/restore-drill.mjs` —— 备份 + 恢复演练

**命令**（在 `/b/AITrance/backend` 下）：

```bash
node ops/restore-drill.mjs > "$TEMP/aitrance-ops-evidence/restore-drill.stdout.json" 2>&1
echo "exit=$?"
```

> 注：该脚本把完整 JSON 报告打到 **stdout**（无 `--report` 参数），`--keep` 可保留临时目录；默认演练结束自动清理临时目录。

**退出码：0**（PASS），**34 项 check 全部 PASS，0 项 FAIL**。

**流程**（全部走**真实 REST 契约**，不是直接写库）：

1. 在系统临时目录 `os.tmpdir()/aitrance-restore-*` 建源库 → `buildApp({ databasePath })` 起源实例；
2. 真实注册 `alice`/`bob`/`carol` → 好友申请 + 接受 → 建私聊 → 发 10 条消息 → 建群（产生 system 消息，占 seq）→ 群发 1 条；
3. **源实例仍在运行（WAL 里还有未 checkpoint 数据）时**，spawn `backup.mjs` 做在线备份；
4. 关闭源实例 → 复制备份到新路径 → `buildApp({ databasePath: 恢复路径 })` 起**恢复实例**；
5. 在恢复实例上验证登录、历史消息逐条一致、续发消息 seq 严格接续、`integrity_check=ok`。

**源库快照（实测）**：

```
users:3, sessions:3, friendships:4, conversations:2, messages:12,
maxMessageId:12, maxSeq:10, directMaxSeq:10, groupMaxSeq:2,
userVersion:1, mainBytesLive:4096, walBytesLive:708672
```

`walBytesLive=708672` 而 `mainBytesLive=4096` —— 即**绝大部分已提交数据当时还在 WAL 里**，正好用来证明备份的一致性。

**备份（实测）**：

| 项 | 实测值 |
| --- | --- |
| 备份耗时 | **187 ms** |
| 备份文件大小 | **114688 bytes** |
| 方法 | `node:sqlite backup()` |
| `integrity_check` | `ok` |
| `countsMatch` | true |
| 备份 `maxSeq` / 源 `maxSeq` | **10 / 10 → 相等** |
| 备份 shasum | `1d7b818d59dd04db5602cdc09d5452cf389b16daec372757669df3f0728b1ab1` |

> **`备份 maxSeq = 源 maxSeq` 是「备份包含 WAL 中已提交数据」的硬证据**，也是 check `备份包含 WAL 中已提交数据（maxSeq 一致）` 的判定依据。

**恢复（实测）**：

| 项 | 实测值 |
| --- | --- |
| 恢复库计数 | `users:3, sessions:3, friendships:4, conversations:2, messages:12`（与源完全一致） |
| 恢复库 `journalMode` | `wal` |
| 恢复库 `userVersion` | `1` |
| 恢复库 `integrity_check` | `["ok"]` |
| 恢复实例登录 | HTTP **200**，返回 **43 字符** Bearer token |
| 历史消息一致性 | **10/10 逐条一致**（msgId/seq/content 全比对） |
| 私聊续发消息 | HTTP **201**，`seq = 11`（= 源 `directMaxSeq 10` + 1） |
| 群聊续发消息 | HTTP **201**，`seq = 3`（= 源 `groupMaxSeq 2` + 1） |

**RTO 实测**：

- **`rtoSeconds = 0.253`（253 ms）**，`rtoBreakdown.totalMs = 253`。
- RTO 定义（脚本内写死并随报告输出）：`从开始恢复（复制备份文件）到恢复实例可登录 + 历史校验 + 续发消息通过`。
- 参照：`buildSourceAppMs = 680`（源实例 buildApp+ready 的耗时，不算入 RTO）。

**RPO 说明（诚实标注，脚本内输出）**：

```json
{
  "statement": "本库是单文件 SQLite，恢复点 = 最近一次成功备份的时刻。RPO 完全取决于备份调度的间隔，脚本本身不提供连续复制/PITR。当前生产侧尚未部署定时备份调度 → RPO 实际未定义（BLOCK）。",
  "lastSuccessfulBackupAt": "2026-10-22T03:36:54.485Z",
  "walCommittedDataIncluded": true
}
```

> **RPO 无法给出具体秒数**：仓库/部署里没有任何定时备份调度（无 cron、无 systemd timer、无 Kubernetes CronJob、无外部备份服务）。一次性备份脚本只能保证「备份那一刻」的恢复点。何时备份 = 生产侧调度，**未部署 → BLOCK**（见第 5 节 B-1）。

---

## OPS-02 容量与监控

### OPS-02a `backend/ops/loadtest.mjs` —— 负载测试

**命令**（在 `/b/AITrance/backend` 下，两档各跑一次）：

```bash
node ops/loadtest.mjs --users 50  --duration 30 --rate 10 --report "$TEMP/aitrance-ops-evidence/load50.json"  > .../load50.stdout.json  2>&1 ; echo "exit=$?"   # → 0
node ops/loadtest.mjs --users 100 --duration 30 --rate 10 --report "$TEMP/aitrance-ops-evidence/load100.json" > .../load100.stdout.json 2>&1 ; echo "exit=$?"   # → 0
```

**退出码：两档均 0**（PASS）。每档 **9 项 check 全部 PASS**（名称见下）。

**测试方法**：`buildApp` + `app.listen({host:'127.0.0.1', port:0})` 起**真实** HTTP/WS 服务；先直接写库 seed N 个用户 + N 条 session + 1 个 N 人群聊（绕过 `register`/`login` 的 10 次/分钟限流，否则造不出 100 用户）；每条 WS 连接单独调 `POST /api/v1/auth/ws-ticket` 取 43 字符 ticket 后连 `ws://.../ws?ticket=<43>&v=1`；用 setTimeout 链把发送速率控制在 10 msg/s，持续 30 秒；独立 probe 循环打 `/health` 与 `/api/v1/auth/session`；最后测边界（单用户第 6 条连接、突发发送触发 429）。

**基线**：REST p95 ≤ **500 ms**、消息到达 p95 ≤ **1000 ms**。

#### 50 用户档实测

| 项 | 实测值 |
| --- | --- |
| 请求/建立连接 | **50 / 50**，全部 `ready` 且 `protocolVersion=1` |
| 建连耗时 | 2841 ms |
| build+ready / listen | 781 ms / 8 ms |
| 实测时长 / 速率 | 30.01 s / **10.00 msg/s** |
| HTTP 建消息 | **300 成功 / 0 失败** |
| DB 落库 | **300 条**（与 HTTP 成功数相等，无静默丢失） |
| 发送用户数 / 单用户最多发送 | 50 / 6 条 |
| **REST 发送 p95** | **9.48 ms**（min 5.33 / p50 6.63 / p99 27.23 / max 51.89 / mean 7.34） |
| REST 探针（health+session）p95 | 6.91 ms（count 116） |
| **消息到达 p95** | **8.71 ms**（count 15000 帧，min 4.55 / p50 6.24 / p99 27.00 / max 51.64） |
| **seq 缺失 / 重复** | **0 / 0**（`clientsWithGaps:0`、`clientsWithDuplicates:0`、`totalDuplicateFrames:0`、`maxMissingPerClient:0`） |
| 单用户连接上限 | 第 1–4 条打开，**第 5、6 条 `close(1008,'Too many connections')`**，`rejectedCount:2` |
| 429 限流 | 突发 80 次 → `201×54 / 429×26`，首次 429 在第 55 次；`Retry-After: 29`；`x-ratelimit-limit: 60`、`remaining: 0`、`reset: 29`；错误体 `{"error":{"code":"RATE_LIMITED","message":"Rate limit exceeded, retry in 29 seconds","traceId":"req-g7"}}` |

#### 100 用户档实测

| 项 | 实测值 |
| --- | --- |
| 请求/建立连接 | **100 / 100**，全部 `ready` 且 `protocolVersion=1`（**达标，无未建立连接**） |
| 建连耗时 | 651 ms |
| build+ready / listen | 257 ms / 6 ms |
| 实测时长 / 速率 | 30.25 s / **9.92 msg/s** |
| HTTP 建消息 | **300 成功 / 0 失败** |
| DB 落库 | **300 条** |
| 发送用户数 / 单用户最多发送 | 100 / 3 条 |
| **REST 发送 p95** | **12.30 ms**（min 7.15 / p50 9.57 / p99 16.15 / max 17.50 / mean 9.83） |
| REST 探针 p95 | 9.63 ms（count 117） |
| **消息到达 p95** | **11.49 ms**（count 30000 帧，min 6.07 / p50 8.90 / p99 15.14 / max 17.23） |
| **seq 缺失 / 重复** | **0 / 0** |
| 单用户连接上限 | 第 5、6 条 `close(1008,'Too many connections')`，`rejectedCount:2` |
| 429 限流 | `201×57 / 429×23`，首次 429 在第 58 次；`Retry-After: 33`；`limit 60`、`remaining 0`、`reset 33`；traceId `req-j3` |

**9 项 check（两档同）全部 PASS**：
`seq 无缺失` / `seq 无重复` / `实测发送速率达到目标 10 msg/s（±10%）` / `REST p95 ≤ 500ms` / `到达 p95 ≤ 1000ms` / `无 HTTP 失败（非 2xx）` / `单用户第 6 条 WS 连接被 close 1008 拒绝` / `突发发送触发 429` / `429 响应带 Retry-After 头`。

**结论：PASS**。100 并发连接全部建立成功，REST p95 与到达 p95 均只有基线的 **~2.5%** 和 **~1.2%**，seq 无缺失无重复。

**观察项（如实记录，不影响判定）**：多次运行中曾出现过 1 次 100 档长尾抖动（`sendRequestMs.p95 = 70.16`、`max = 806 ms`），仍在基线内但说明存在偶发长尾（推测与 JIT/GC/Windows 定时器精度有关，未进一步定位）。上面表内数字取自最终一次两档正式运行。

---

### OPS-02b `backend/ops/health-probe.mjs` —— 健康探测与阈值告警

**阈值常量**（脚本内定义）：`DISK_MIN_FREE_PERCENT = 10`、`ERROR_RATE_MAX_PERCENT = 1`、`HEALTH_MAX_CONSECUTIVE_FAILURES = 3`、`PROBE_P95_WARN_MS = 500`、`WAL_WARN_MIN_BYTES = 64 MiB`、`WAL_WARN_RATIO = 10`。

**告警码**：CRITICAL = `HEALTH_CONSECUTIVE_FAILURES`、`DISK_LOW`、`DB_INTEGRITY`、`DB_UNREADABLE`、`DB_SCHEMA_MISMATCH`、`HTTP_5XX_RATE`；WARN = `PROBE_SLOW`、`DB_WAL_LARGE`；INFO = `ALL_CLEAR`。
**退出码**：`0` = 无 CRITICAL，`1` = 有 CRITICAL，`2` = 参数/环境错误。

#### 场景 A：正常态（真实起 server）

起服务：

```bash
DATABASE_PATH="$TEMP/aitrance-ops-final/health2/health.sqlite" PORT=3104 HOST=127.0.0.1 \
  node dist/src/server.js > "$TEMP/aitrance-ops-final/health2/server.log" 2>&1 &
# GET /health → 200
```

探测：

```bash
node ops/health-probe.mjs \
  --base-url http://127.0.0.1:3104 \
  --database "$TEMP/aitrance-ops-final/health2/health.sqlite" \
  --log "$TEMP/aitrance-ops-final/health2/server.log" \
  --rounds 5 --interval 300 \
  --report "$TEMP/aitrance-ops-evidence/health-probe.json"
echo "exit=$?"
```

**退出码：0，`status: "OK"`，`ok: true`**（PASS）

| 项 | 实测值 |
| --- | --- |
| `/health` | **5/5 成功**，`min 2.02 / p50 2.40 / p95 39.79 / max 39.79 ms`（首个请求含 DNS+TLS 无关的本地连接建立，故 p95 偏高） |
| `/api/v1/health` | **5/5 成功**，`min 1.69 / p50 1.99 / p95 2.30 / max 2.30 ms` |
| 响应体 | `{"status":"ok","version":"0.2.0","protocolVersion":1,"serverTime":"..."}` |
| 磁盘 | `totalBytes 160098676736`、`availableBytes 41475903488`、**`freePercent 25.91`**（> 10% 阈值，未告警） |
| 数据库 | `mainBytes 4096`、`walBytes 168952`、`shmBytes 32768`、`integrityCheck ["ok"]`、`integrityOk true`、`userVersion 1`、`journalMode "wal"`、`missingTables []`、counts 全 0（新库） |
| 日志 5xx | `scannedLines 5`、`matchedRequests 2`、`matchedErrors 0`、**`errorRatePercent 0`** |
| alerts | `[{"level":"INFO","code":"ALL_CLEAR","message":"所有阈值均未触发"}]` |

#### 场景 B：服务不可用（负向）

```bash
node ops/health-probe.mjs --base-url http://127.0.0.1:3999 --rounds 4 --interval 100 \
  --report "$TEMP/aitrance-ops-evidence/health-probe-down.json"
echo "exit=$?"
```

**退出码：1，`status: "CRITICAL"`**（PASS，告警正确触发）

```json
[{"level":"CRITICAL","code":"HEALTH_CONSECUTIVE_FAILURES","message":"/health 连续 4 次失败（阈值 3）"},
 {"level":"CRITICAL","code":"HEALTH_CONSECUTIVE_FAILURES","message":"/api/v1/health 连续 4 次失败（阈值 3）"}]
```

#### 场景 C：WAL 异常膨胀（负向，真实构造）

构造：含真实 5 张业务表 + 额外 blobs 表，`PRAGMA wal_autocheckpoint=0` 写入 320 × 256 KB blob。

```bash
node -e "...构造 walbig.sqlite..."
# live main 4096 B / live wal 87257512 B   ← 应用未关闭时
node ops/health-probe.mjs --database "$TEMP/aitrance-ops-final/wal/walbig.sqlite" --report ...
echo "exit=$?"
```

**退出码：0（WARN 不等于 CRITICAL），`status: "WARN"`**（PASS）

```json
{"alerts":[{"level":"WARN","code":"DB_WAL_LARGE",
  "message":"WAL 87257512 bytes 超过主库 4096 bytes 的 10 倍（且 > 67108864 bytes 下限），长期未 checkpoint"}],
 "database":{"mainBytes":4096,"walBytes":87257512,"integrityCheck":["ok"],"missingTables":[]}}
```

#### 场景 D：`--database` 指错文件 / schema 未初始化（负向）

```bash
node ops/health-probe.mjs --database <只有 blobs 表、无业务表的库>
```

**退出码：1，`status: "CRITICAL"`**（PASS）

```json
{"alerts":[{"level":"CRITICAL","code":"DB_SCHEMA_MISMATCH",
  "message":"数据库缺少表 users, sessions, messages, conversations, ws_tickets（--database 可能指向了错误的文件，或 schema 未初始化）"}]}
```

**本项修过两个真实 bug**：
1. **WAL 假阳性**：新建空库主库只有 4 KB，WAL 里光 schema 就有 ~169 KB，「10 倍」规则会立刻误报 `DB_WAL_LARGE` → 增加绝对下限 `WAL_WARN_MIN_BYTES = 64 MiB`，只有「既超 10 倍又超 64 MiB」才告警。
2. **表不存在被误判成「库打不开」**：原实现对固定 5 张表直接 `SELECT COUNT(*)`，表不存在时抛错进 `readError` → 报 `DB_UNREADABLE`（语义错误）。改为先查 `sqlite_master` 建表集合，缺失表计数记 `null` 并写入 `missingTables[]`，新增 `DB_SCHEMA_MISMATCH` CRITICAL。

---

### OPS-02c 告警演练步骤 —— `backend/ops/alert-drill.md`

已交付 137 行演练文档，含：监控工具与边界事实表、告警码/阈值表、7 步演练流程（正常态快照 → 可用性告警 → 磁盘告警 → 完整性告警 → 接通真实通道 → 送达验证 → 值班表与升级路径）。

**诚实结论**：

| 项 | 状态 |
| --- | --- |
| 阈值判定逻辑 | **PASS**（场景 A/B/C/D 均实测，见上） |
| 真实告警送达 | **BLOCK**（仓库内无 SMTP / webhook / IM 机器人 / PagerDuty 等任何通道配置） |
| 值班表与升级路径 | **BLOCK**（无 on-call 名单、无接收人、无升级链） |
| 无生产环境访问权 | **BLOCK**（本机无法对生产部署执行任何演练） |

---

## OPS-03 用户清理盘点（**仅 dry-run**）

### OPS-03a `backend/ops/seed-fixture.mjs` —— 构造隔离样本库

```bash
node ops/seed-fixture.mjs \
  --database "$TEMP/aitrance-ops-final/fixture/fixture.sqlite" \
  --report "$TEMP/aitrance-ops-evidence/seed-fixture.json"
echo "exit=$?"
```

**退出码：0**（PASS）。counts：

```
users:4, sessions:5, ws_tickets:1, friendships:5,
friend_requests:2, conversations:4, conversation_members:8, messages:8
```

夹具覆盖的边界：alice 有 **2 条 session**；friendships 含**单向** bob→carol；**dave 是某私聊的唯一成员**（专门验证「唯一成员」影响面）；群聊由 alice 当群主；每会话 seq 从 1 连续。

### OPS-03b `backend/ops/cleanup-probe.mjs` —— dry-run 盘点（**未执行 --execute**）

```bash
node ops/cleanup-probe.mjs \
  --database "$TEMP/aitrance-ops-final/fixture/fixture.sqlite" \
  --usernames alice,dave \
  --report "$TEMP/aitrance-ops-evidence/cleanup-dryrun-1.json"
echo "exit=$?"
```

**退出码：0，`mode: "dry-run"`，`ok: true`**（PASS）

**确定性验证**：同一库连跑两次（`cleanup-dryrun-1.json` / `cleanup-dryrun-2.json`），除 `generatedAt` 时间戳外**逐字段完全相同**，`planHash` 均为 **`80db1ec8745186f138ce836de5ed39764d8c2618fcd3c6f878078880d140755c`**。

**只读性证明**：dry-run 前后 `sha256sum fixture.sqlite` 均为 `30aeb67ac67e4b8dd894ac542c68e828468233bd17935c5252c69cc5f6bdea70`（**未变**）。注：以 `readOnly` 打开仍会让 SQLite 生成 `-wal`/`-shm` 影子文件（0 字节 WAL + 32 KB SHM），这是 SQLite 自身行为，不改变主库字节。

**alice 影响面（实测）**：

```
counts: users:1, sessions:2, ws_tickets:1, friendships:4, friend_requests:1,
        conversations_owned:1, conversation_members:2, conversations_involved:2, messages:3
impact: soleMembershipCount:0, conversationsBecomingEmpty:0, groupConversationsLosingMember:2
```

**dave 影响面（实测，验证「是否仍是某会话唯一成员」）**：

```
counts: users:1, sessions:1, ws_tickets:0, friendships:0, friend_requests:1,
        conversations_owned:0, conversation_members:1, conversations_involved:1, messages:1
impact: soleMembershipCount:1,
        soleMemberships:[{"conversationId":"93dde1fd-...","type":"direct","name":"","messageCount":1}],
        conversationsBecomingEmpty:1
```

**非目标数据不变性证明（聚合摘要）**：

```json
{"digest":"e553343a5aba33c266fb499d3c0f13c75d4bed9771cbb1d174fed2780ddd9a21",
 "retainedTotal":20,
 "perTable":{
   "users":{"totalRows":4,"retainedRows":2},
   "sessions":{"totalRows":5,"retainedRows":2},
   "friend_requests":{"totalRows":2,"retainedRows":1},
   "friendships":{"totalRows":5,"retainedRows":1},
   "conversations":{"totalRows":4,"retainedRows":4},
   "conversation_members":{"totalRows":8,"retainedRows":5},
   "messages":{"totalRows":8,"retainedRows":4},
   "ws_tickets":{"totalRows":1,"retainedRows":1}}}
```

`summaryLine` 实测输出：

```
dry-run: 命中 2/2 个用户，非目标保留行 20，aggregateHash=e553343a5aba33c2…，planHash=80db1ec8745186f1…（未修改任何数据）
```

### OPS-03c 安全门实测（**全部拒绝，未删任何数据**）

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| `--execute` 但确认 hash 错误 | `node ops/cleanup-probe.mjs --database <fixture> --usernames alice,dave --execute --confirm deadbeef` | **退出码 1**，`ok:false`，`error: "--confirm 与当前盘点 planHash 不一致（传入 deadbeef，实际 80db1ec8745186f138ce836de5ed39764d8c2618fcd3c6f878078880d140755c）"`，`execution:null`、`after:null`；fixture sha256 前后未变 |
| 未指定用户名 | `node ops/cleanup-probe.mjs --database <fixture>` | **退出码 2**，stderr `错误：至少指定一个 --usernames / --username` |
| 用户名不存在 | `node ops/cleanup-probe.mjs --database <fixture> --usernames nosuchuser` | 退出码 0（dry-run 不算失败），`found:0`、`missing:["nosuchuser"]` |

**`--execute` 从未被成功执行过**（红线遵守）。`--execute` 路径设计为三重门，任一不满足即拒绝：

1. `--confirm` 必须等于**当前盘点** `planHash`（防止对已变化的库执行旧计划）；
2. `missing` 必须为空（目标用户必须全部存在，避免误删或静默跳过）；
3. 必须先 spawn `ops/backup.mjs` 备份成功，否则拒绝执行。

执行体在 `BEGIN IMMEDIATE` … `COMMIT` 事务内，失败 `ROLLBACK`。

---

## 5. PASS / BLOCK 汇总

### PASS（已真实跑通，有实测数字）

| 编号 | 项 | 关键实测 |
| --- | --- | --- |
| OPS-01a | 一致性备份 `backup.mjs` | exit 0；`node:sqlite backup()`；11 ms；114688 B；integrity ok；countsMatch true；分区可用 25.9% |
| OPS-01b | 备份+恢复演练 `restore-drill.mjs` | exit 0；**34/34 check PASS**；备份 187 ms；备份 maxSeq=源 maxSeq=10（含 WAL 已提交数据）；恢复 integrity ok、登录 200、历史 10/10、私聊续发 seq=11、群发 seq=3；**RTO = 0.253 s** |
| OPS-02a(50) | 负载 50 用户 | exit 0；50/50 连接；10.00 msg/s × 30.01 s；HTTP 300/300 成功、DB 300 条；**REST p95 9.48 ms**、**到达 p95 8.71 ms**；seq 缺失 0、重复 0；第 6 条连接 1008；429 + `Retry-After: 29` |
| OPS-02a(100) | 负载 100 用户 | exit 0；**100/100 连接（达标）**；9.92 msg/s × 30.25 s；HTTP 300/300、DB 300 条；**REST p95 12.30 ms**、**到达 p95 11.49 ms**；seq 缺失 0、重复 0；429 + `Retry-After: 33` |
| OPS-02b(A) | 健康探测正常态 | exit 0 / OK；`/health` 5/5（p50 2.40 ms）、`/api/v1/health` 5/5（p50 1.99 ms）；磁盘 25.91%；integrity ok；5xx 0% |
| OPS-02b(B) | 服务不可用 | exit 1 / CRITICAL；`HEALTH_CONSECUTIVE_FAILURES` 连续 4 次（阈值 3） |
| OPS-02b(C) | WAL 膨胀 | WARN `DB_WAL_LARGE`（wal 87257512 B vs main 4096 B） |
| OPS-02b(D) | schema 不匹配 | CRITICAL `DB_SCHEMA_MISMATCH`（缺 5 张业务表） |
| OPS-03a | 样本夹具 `seed-fixture.mjs` | exit 0；4 用户 / 5 session / 4 会话 / 8 消息 |
| OPS-03b | 清理 dry-run | exit 0；`planHash` 两次一致（确定性）；sha256 前后不变（只读）；非目标保留 20 行、aggregate digest `e553343a…`；「唯一成员」影响面（dave）正确识别 |
| OPS-03c | 安全门 | 错误 confirm → exit 1 拒绝；无用户名 → exit 2 拒绝；**`--execute` 从未执行** |

### BLOCK（未完成，必须如实标注）

| 编号 | BLOCK 内容 | 原因 / 现状 |
| --- | --- | --- |
| **B-1** | **生产侧定时备份调度未部署 → RPO 未定义** | 仓库与部署配置里没有任何定时备份（无 cron / systemd timer / K8s CronJob / 外部备份服务）。`backup.mjs` 只能按调用时刻备份，恢复点 = 最近一次成功备份。**RPO 具体秒数无法给出**。需由有生产环境权限的人部署调度（并接入再加 `restore-drill` 定期抽验）。 |
| **B-2** | **告警通道 / 值班人（on-call）缺失 → 真实告警送达未验证** | 仓库内无 SMTP / webhook / IM 机器人 / PagerDuty 等任何通道配置，也无 on-call 名单与升级路径。已交付 `health-probe.mjs`（阈值判定逻辑 4 个场景实测通过）与 `alert-drill.md`（7 步演练步骤），但「真实发出告警并确认有人收到/回执」**未执行也无法执行**。 |
| **B-3** | **OPS-03 用户清理仍未获批准 → 未执行 `--execute`** | 需要用户明确批准删除哪些生产用户，且需**先做生产库快照盘点**（生产数据量与隔离夹具差异极大）。`cleanup-probe.mjs` 的 dry-run 工具已就绪并实测（含 planHash 确定性、三重门、备份前置），`--execute` 路径**从未运行**。 |

---

## 6. 需其他角色配合的问题（非 BLOCK，但影响生产可用性）

1. **`health-probe` 的 5xx 比例靠解析应用日志**（`--log`），统计是粗粒度的正则匹配，日志轮转/格式变化会影响准确性。若生产要精确 5xx/SLO，应接入指标系统（Prometheus 等）而非日志解析。→ 需 Lead 决定是否立项。
2. **`backend/deploy/` 的 env 示例与文档可能未同步 backend-core 新增的配置项**（`TLS_CERT_PATH` / `TLS_KEY_PATH` / `REQUIRE_HTTPS` / `RETENTION_SWEEP_SECONDS` / `RETENTION_MESSAGE_DAYS`）。本 agent 未修改 `backend/deploy/`（红线），**未核实**其是否已更新，请负责部署配置的同事确认。→ 需 Lead 分派。
3. **负载测试的 100 用户档只覆盖单一群聊广播**（1 个 N 人群聊，每条消息扇出 N 帧）。真实产品会有多会话并发、私聊+群聊混合、在线/离线混合。若要更有说服力的容量结论，建议增加多会话场景（本 agent 未做，避免超出任务范围）。→ 建议 Lead 决定是否补测。
4. **本次全部数字均在 Windows 开发工作站、`127.0.0.1` 回环、单进程内测得**。生产（Linux、真实网络、可能多实例）数字会不同，**不能直接当作生产 SLO 承诺**。

---

## 7. 清理与红线自检

| 检查项 | 结果 |
| --- | --- |
| 是否只写了 `backend/ops/` 与 `backend/evidence/ops.md` | 是（未碰 `backend/src/`、`backend/test/`、`backend/deploy/`、`frontend/`、`docs/`、`contracts/`、`management/`、`session.txt`、`monitor.ps1`） |
| 是否 `git commit` / `git tag` | **否** |
| 是否运行 `backend/deploy/reset-chat.mjs` | **否** |
| 是否成功执行 `cleanup-probe.mjs --execute` | **否**（仅被拒绝的尝试，未删数据） |
| 是否碰生产库 / SSH / 公网 / `/opt` | **否**，全部演练在 `os.tmpdir()` 隔离库 |
| `backend/` 下是否残留本 agent 产生的 `*.sqlite` | **无**。仅存在原有 `backend/.data/chat.sqlite`、`backend/.data/e2e-responsive.sqlite`、`backend/.data/deploy/reset-check-*.sqlite`，以及**其他 agent 产生**的 `backend/evidence/.sis.sqlite`（11:41 出现，本 agent 未创建、未引用、未删除，属 teammate 的 smoke 脚本产物，不在本 agent 写入范围） |
| 临时目录 | 已清理 `$TEMP/aitrance-ops-final`、`$TEMP/aitrance-ops-evidence` 及全部 `$TEMP/aitrance-*`（`restore-drill`/`loadtest` 自身在 `finally` 中清理各自的临时目录）；清理后 `ls -d $TEMP/aitrance-*` 返回空 |
| 测试用 server 进程 | 已 `Stop-Process` 停止（3103、3104 端口已释放） |
