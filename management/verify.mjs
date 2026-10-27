import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.some(argument => argument !== '--skip-audit')) {
  console.error('Usage: node management/verify.mjs [--skip-audit]')
  process.exit(2)
}
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Node.js 24 or newer is required')
  process.exit(2)
}

const evidenceRoot = join(root, 'management/evidence')
mkdirSync(evidenceRoot, { recursive: true })
const runRoot = mkdtempSync(join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'))
const snapshot = join(runRoot, 'snapshot')
const report = {
  startedAt: new Date().toISOString(), nodeVersion: process.version,
  scope: 'local automated gates only; NOT production release approval',
  dependencyMode: 'existing installed packages, checked against locks; not a clean npm ci',
  results: [],
}
const sources = []
const sourceRoots = []

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function includeFile(path) {
  const name = path.split(/[\\/]/).pop()
  if (name.startsWith('.') && !['.env.production', '.env.example'].includes(name)) return false
  return /\.(?:ts|vue|mjs|json|html|css|md|svg|png|ico|webp|jpg|conf|service)$/.test(name)
    || ['.env.production', '.env.example'].includes(name)
}

function copySource(source, destination) {
  if (statSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || ['node_modules', 'dist', '.data', '.git', 'evidence', 'backups'].includes(entry.name)) continue
      copySource(join(source, entry.name), join(destination, entry.name))
    }
  } else if (includeFile(source)) {
    mkdirSync(dirname(destination), { recursive: true })
    const before = digestFile(source)
    copyFileSync(source, destination)
    if (digestFile(destination) !== before || digestFile(source) !== before) {
      throw new Error(`Source changed during snapshot: ${relative(root, source)}`)
    }
    sources.push({ path: relative(root, source).replaceAll('\\', '/'), sha256: before })
  }
}

function captureSource(source, destination) {
  sourceRoots.push(source)
  copySource(source, destination)
}

function currentSources(source, manifest) {
  if (!existsSync(source)) return
  if (statSync(source).isDirectory()) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', 'dist', '.data', '.git', 'evidence', 'backups'].includes(entry.name)) continue
      currentSources(join(source, entry.name), manifest)
    }
  } else if (includeFile(source)) {
    manifest.set(relative(root, source).replaceAll('\\', '/'), digestFile(source))
  }
}

function record(name, status, details) {
  report.results.push({ name, status, ...details })
  console.log(`${status.toUpperCase()} ${name}`)
}

const environment = { ...process.env }
for (const key of Object.keys(environment)) {
  if (key.startsWith('VITE_')) delete environment[key]
}
Object.assign(environment, {
  HOST: '127.0.0.1', PORT: '3001', DATABASE_PATH: ':memory:',
  CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  SESSION_TTL_DAYS: '7', TRUST_LOOPBACK_PROXY: 'false', DEFAULT_FRIEND_USERNAME: '',
  LOG_LEVEL: 'info', VITE_USE_MOCK: 'false', NO_COLOR: '1',
})
delete environment.FORCE_COLOR

function run(name, project, executable, commandArgs, shell = false) {
  const started = Date.now()
  const result = spawnSync(executable, commandArgs, {
    cwd: join(snapshot, project), env: environment, encoding: 'utf8',
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell,
  })
  const logPath = join(runRoot, `${name}.log`)
  writeFileSync(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`, 'utf8')
  record(name, result.status === 0 && !result.error ? 'passed' : 'failed', {
    exitCode: result.status, signal: result.signal, durationMs: Date.now() - started,
    command: [executable === process.execPath ? 'node' : executable, ...commandArgs],
    log: relative(root, logPath).replaceAll('\\', '/'),
  })
  if (result.status !== 0) console.log((result.stdout ?? '').slice(-1400))
  return result
}

function runNode(name, project, commandArgs) {
  return run(name, project, process.execPath, commandArgs)
}

function verifyInstalled(project) {
  const lock = JSON.parse(readFileSync(join(snapshot, project, 'package-lock.json'), 'utf8'))
  const mismatches = []
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || metadata.link) continue
    const installed = join(root, project, path, 'package.json')
    if (!existsSync(installed)) {
      if (!metadata.optional) mismatches.push(`${path}: not installed`)
    } else if (JSON.parse(readFileSync(installed, 'utf8')).version !== metadata.version) {
      mismatches.push(`${path}: version differs from lock`)
    }
  }
  if (!lock.packages) mismatches.push('lockfile does not contain packages')
  record(`${project}-installed-lock`, mismatches.length ? 'failed' : 'passed', { mismatches })
}

function overlay(path, previous, replacement) {
  const destination = join(snapshot, 'frontend', path)
  const content = readFileSync(destination, 'utf8')
  if (content.split(previous).length !== 2) throw new Error(`Deployment overlay no longer matches ${path}; coordinate with backend`)
  writeFileSync(destination, content.replace(previous, replacement), 'utf8')
}

try {
  for (const project of ['frontend', 'backend']) {
    const destination = join(snapshot, project)
    mkdirSync(destination, { recursive: true })
    const paths = project === 'frontend'
      ? ['src', 'mocks', 'public', 'scripts', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', '.env.production']
      : ['src', 'test', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'openapi.json']
    for (const path of paths) captureSource(join(root, project, path), join(destination, path))
    symlinkSync(join(root, project, 'node_modules'), join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    verifyInstalled(project)
  }
  captureSource(join(root, 'contracts'), join(snapshot, 'contracts'))
  captureSource(join(root, 'scripts/check-contract.mjs'), join(snapshot, 'scripts/check-contract.mjs'))
  captureSource(join(root, 'management/tests'), join(snapshot, 'pm-tests'))
  captureSource(join(root, 'management/verify.mjs'), join(snapshot, 'pm-runner/verify.mjs'))
  captureSource(join(root, 'management/browser-check.mjs'), join(snapshot, 'pm-runner/browser-check.mjs'))
  symlinkSync(join(root, 'frontend/node_modules'), join(snapshot, 'pm-tests/node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  mkdirSync(join(snapshot, 'docs/contract'), { recursive: true })
  sources.sort((left, right) => left.path.localeCompare(right.path))
  report.sourceSha256 = createHash('sha256').update(JSON.stringify(sources)).digest('hex')
  writeFileSync(join(runRoot, 'source-manifest.json'), JSON.stringify(sources, null, 2) + '\n')

  runNode('frontend-typecheck', 'frontend', ['node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'])
  runNode('frontend-tests', 'frontend', ['node_modules/vitest/vitest.mjs', 'run'])
  runNode('pm-regressions', 'frontend', ['node_modules/vitest/vitest.mjs', 'run', '--config', '../pm-tests/vitest.config.mjs'])
  const backendBuild = runNode('backend-build', 'backend', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'])
  if (backendBuild.status === 0) {
    const tests = readdirSync(join(snapshot, 'backend/dist/test')).filter(name => name.endsWith('.test.js'))
    if (!tests.length) throw new Error('Backend build contains no test files')
    runNode('backend-tests', 'backend', ['--test', ...tests.map(name => `dist/test/${name}`)])
    const previousOpenapi = readFileSync(join(snapshot, 'backend/openapi.json'), 'utf8')
    const docs = runNode('backend-openapi', 'backend', ['dist/scripts/openapi.js'])
    if (docs.status === 0) {
      const generatedOpenapi = readFileSync(join(snapshot, 'backend/openapi.json'), 'utf8')
      record('openapi-freshness', JSON.stringify(JSON.parse(previousOpenapi)) === JSON.stringify(JSON.parse(generatedOpenapi)) ? 'passed' : 'failed', {})
    }
  } else {
    record('backend-tests', 'skipped', { reason: 'backend build failed' })
    record('backend-openapi', 'skipped', { reason: 'backend build failed' })
  }
  runNode('contract', '', ['scripts/check-contract.mjs', '--json'])
  runNode('contract-self-test', '', ['scripts/check-contract.mjs', '--self-test', '--quiet'])

  overlay('vite.config.ts', 'export default defineConfig({', "export default defineConfig({\n  base: '/chat/',")
  overlay('src/router/index.ts', 'history: createWebHistory(),', 'history: createWebHistory(import.meta.env.BASE_URL),')
  overlay('src/api/http.ts', "baseURL: '',", 'baseURL: import.meta.env.BASE_URL,')
  overlay('src/ws/client.ts', '${location.host}/ws?ticket=', '${location.host}${import.meta.env.BASE_URL}ws?ticket=')
  record('deployment-overlay', 'passed', { base: '/chat/' })
  runNode('deployment-typecheck', 'frontend', ['node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'])
  const webBuild = runNode('frontend-build', 'frontend', ['node_modules/vite/bin/vite.js', 'build'])
  if (webBuild.status === 0) {
    runNode('strip-mock-worker', 'frontend', ['scripts/strip-mock-worker.mjs'])
    const dist = join(snapshot, 'frontend/dist')
    const index = readFileSync(join(dist, 'index.html'), 'utf8')
    const assets = readdirSync(join(dist, 'assets'))
    const unexpectedMocks = assets.filter(name => /(?:browser|mock|msw)/i.test(name))
    record('web-assets', index.includes('/chat/assets/') && !existsSync(join(dist, 'mockServiceWorker.js')) && unexpectedMocks.length === 0 ? 'passed' : 'failed', {
      indexSha256: digestFile(join(dist, 'index.html')), unexpectedMocks,
      assets: assets.map(name => ({ path: name, sha256: digestFile(join(dist, 'assets', name)) })),
      caveat: 'asset checks do not replace browser deep-link/API/WS tests',
    })
    if (backendBuild.status === 0) {
      runNode('browser-security', '', [join(root, 'management/browser-check.mjs'), snapshot])
    } else {
      record('browser-security', 'skipped', { reason: 'backend build failed' })
    }
  } else {
    record('web-assets', 'skipped', { reason: 'frontend build failed' })
  }

  for (const project of ['frontend', 'backend']) {
    if (args.includes('--skip-audit')) {
      record(`${project}-audit`, 'skipped', { reason: '--skip-audit requested; release gate remains incomplete' })
      continue
    }
    const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const auditArgs = ['audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org']
    const result = existsSync(npmCli)
      ? runNode(`${project}-audit`, project, [npmCli, ...auditArgs])
      : run(`${project}-audit`, project, process.platform === 'win32' ? 'npm.cmd' : 'npm', auditArgs, process.platform === 'win32')
    try {
      const audit = JSON.parse(result.stdout)
      const item = report.results.at(-1)
      item.vulnerabilities = audit.metadata?.vulnerabilities ?? null
      item.advisories = Object.values(audit.vulnerabilities ?? {}).map(entry => ({
        name: entry.name, severity: entry.severity, range: entry.range, fixAvailable: entry.fixAvailable,
        via: entry.via,
      }))
      if (audit.error || !item.vulnerabilities) item.status = 'failed'
    } catch {
      report.results.at(-1).status = 'failed'
    }
  }
} catch (error) {
  record('verification-runtime', 'failed', { error: error.message })
} finally {
  const current = new Map()
  for (const source of sourceRoots) currentSources(source, current)
  const expected = new Map(sources.map(source => [source.path, source.sha256]))
  const changed = [...new Set([...current.keys(), ...expected.keys()])]
    .filter(path => current.get(path) !== expected.get(path)).sort()
  record('source-stability', changed.length ? 'failed' : 'passed', { changed })
  report.finishedAt = new Date().toISOString()
  report.automatedGate = report.results.every(result => result.status === 'passed') ? 'passed' : 'failed-or-incomplete'
  report.productionApproval = 'NOT_ASSESSED'
  writeFileSync(join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Report: ${relative(root, join(runRoot, 'report.json'))}`)
  console.log(`Automated gate: ${report.automatedGate}; production is NOT approved by this script`)
  process.exitCode = report.automatedGate === 'passed' ? 0 : 1
}
