#!/usr/bin/env node
/**
 * OPS-02 健康探测 / 监控快照
 *
 * 做什么：
 *   1. 探测 `/health` 与 `/api/v1/health`（可多轮，统计连续失败次数与延迟）；
 *   2. 读取数据库文件所在分区的可用空间百分比（fs.statfsSync）；
 *   3. 读取数据库文件大小、WAL 大小、`PRAGMA integrity_check` 快照（只读打开，不写源库）；
 *   4. 抓取进程 5xx 计数：通过一个只读探针端点无法拿到，因此这里按「本轮探测 + 可选的
 *      外部日志文件计数」两种口径输出；若未提供日志，5xx 计数记为 null 并说明原因（不虚构）；
 *   5. 输出 JSON 快照，并按内置阈值给出告警建议。
 *
 * 内置告警阈值（需求书给定）：
 *   - 磁盘可用 < 10%          → CRITICAL
 *   - 5xx 比例 > 1%           → CRITICAL（需配合日志/指标来源，本脚本只做快照）
 *   - `/health` 连续 3 次失败 → CRITICAL
 *   - 附加建议：探测 p95 > 500ms → WARN；数据库 integrity_check 非 ok → CRITICAL；
 *     WAL 文件 > 数据库主文件 10 倍 → WARN（长期未 checkpoint 迹象）
 *
 * 用法：
 *   node ops/health-probe.mjs --base-url http://127.0.0.1:3001 --database <db路径> [--rounds 5] [--interval 2000]
 *   node ops/health-probe.mjs --database .data/chat.sqlite          # 只做磁盘/库快照
 *   node ops/health-probe.mjs --base-url ... --log <应用日志文件>     # 粗略统计 5xx
 *
 * 退出码：0 = 无 CRITICAL；1 = 有 CRITICAL；2 = 参数错误。
 */

import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DISK_MIN_FREE_PERCENT = 10;
const ERROR_RATE_MAX_PERCENT = 1;
const HEALTH_MAX_CONSECUTIVE_FAILURES = 3;
const PROBE_P95_WARN_MS = 500;
/**
 * WAL 告警的下限护栏（避免新库刚启动时的假阳性）：
 * 新建的空库主文件只有 4 KB，而 WAL 里已有 schema+少量页就会到 ~168 KB，
 * 按「10 倍」规则会立刻误报。因此只有「绝对大小也超过下限」才报。
 */
const WAL_WARN_MIN_BYTES = 64 * 1024 * 1024;
const WAL_WARN_RATIO = 10;

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    database: process.env.DATABASE_PATH ?? '',
    rounds: 5,
    intervalMs: 2000,
    log: '',
    report: '',
    timeoutMs: 5000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺少参数值`);
      index += 1;
      return value;
    };
    if (token === '--base-url') args.baseUrl = takeValue();
    else if (token === '--database') args.database = takeValue();
    else if (token === '--rounds') args.rounds = Number(takeValue());
    else if (token === '--interval') args.intervalMs = Number(takeValue());
    else if (token === '--timeout') args.timeoutMs = Number(takeValue());
    else if (token === '--log') args.log = takeValue();
    else if (token === '--report') args.report = takeValue();
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数: ${token}`);
  }
  return args;
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function round(value, digits = 2) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function probe(url, timeoutMs) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { origin: 'http://localhost:5173' } });
    const body = await response.text();
    return {
      url,
      ok: response.ok,
      status: response.status,
      latencyMs: performance.now() - startedAt,
      body: body.slice(0, 400),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function diskSnapshot(path) {
  if (!path || !existsSync(path)) return { path, exists: false };
  const target = dirname(resolve(path));
  const stat = statfsSync(target);
  const totalBytes = Number(stat.blocks) * Number(stat.bsize);
  const availableBytes = Number(stat.bavail) * Number(stat.bsize);
  return {
    path: target,
    exists: true,
    totalBytes,
    availableBytes,
    freePercent: totalBytes > 0 ? round((availableBytes / totalBytes) * 100, 2) : null,
  };
}

function databaseSnapshot(path) {
  if (!path || !existsSync(path)) return { path, exists: false };
  const mainBytes = statSync(path).size;
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
  const snapshot = {
    path: resolve(path),
    exists: true,
    mainBytes,
    walBytes,
    shmBytes: existsSync(shmPath) ? statSync(shmPath).size : 0,
  };
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = database.prepare('PRAGMA integrity_check').all().map(row => String(Object.values(row)[0]));
      snapshot.integrityCheck = integrity;
      snapshot.integrityOk = integrity.length === 1 && integrity[0] === 'ok';
      snapshot.userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      snapshot.journalMode = String(database.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '');
      // 逐表计数：表不存在属于「schema 不匹配」（比如指错了文件），不应该算「库打不开」。
      const existingTables = new Set(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)),
      );
      const counts = {};
      const missingTables = [];
      for (const table of ['users', 'sessions', 'messages', 'conversations', 'ws_tickets']) {
        if (!existingTables.has(table)) {
          counts[table] = null;
          missingTables.push(table);
          continue;
        }
        const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        counts[table] = Number(row?.n ?? 0);
      }
      snapshot.counts = counts;
      snapshot.missingTables = missingTables;
    } finally {
      database.close();
    }
  } catch (error) {
    snapshot.readError = error instanceof Error ? error.message : String(error);
  }
  return snapshot;
}

/** 从应用日志里粗略统计 5xx 行（Pino JSON 或纯文本），没有日志就返回 null */
function logErrorRate(path) {
  if (!path || !existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  let total = 0;
  let errors = 0;
  for (const line of lines) {
    if (/"msg":"(incoming request|request completed)"/.test(line) || /request completed/.test(line)) total += 1;
    else if (/"level":50/.test(line) || /"statusCode":5\d\d/.test(line)) errors += 1;
    else if (/"msg":"Request failed"/.test(line)) errors += 1;
  }
  return {
    path: resolve(path),
    scannedLines: lines.length,
    matchedRequests: total,
    matchedErrors: errors,
    errorRatePercent: total > 0 ? round((errors / total) * 100, 2) : null,
    note: total === 0 ? '日志中没有可识别的请求完成行，无法计算 5xx 比例' : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node ops/health-probe.mjs --base-url http://127.0.0.1:3001 --database <db> [--rounds 5]');
    return 0;
  }

  const report = {
    tool: 'ops/health-probe.mjs',
    node: process.version,
    startedAt: new Date().toISOString(),
    thresholds: {
      diskMinFreePercent: DISK_MIN_FREE_PERCENT,
      errorRateMaxPercent: ERROR_RATE_MAX_PERCENT,
      healthMaxConsecutiveFailures: HEALTH_MAX_CONSECUTIVE_FAILURES,
      probeP95WarnMs: PROBE_P95_WARN_MS,
    },
    probes: {},
    disk: diskSnapshot(args.database),
    database: databaseSnapshot(args.database),
    serverErrors: logErrorRate(args.log),
    alerts: [],
    status: 'OK',
  };

  const raise = (level, code, message) => {
    report.alerts.push({ level, code, message });
    if (level === 'CRITICAL') report.status = 'CRITICAL';
    else if (level === 'WARN' && report.status === 'OK') report.status = 'WARN';
  };

  if (args.baseUrl) {
    const base = args.baseUrl.replace(/\/+$/, '');
    const paths = ['/health', '/api/v1/health'];
    for (const path of paths) {
      const samples = [];
      let consecutiveFailures = 0;
      let maxConsecutiveFailures = 0;
      for (let round = 0; round < args.rounds; round += 1) {
        const result = await probe(`${base}${path}`, args.timeoutMs);
        samples.push(result);
        if (result.ok) consecutiveFailures = 0;
        else {
          consecutiveFailures += 1;
          maxConsecutiveFailures = Math.max(maxConsecutiveFailures, consecutiveFailures);
        }
        if (round < args.rounds - 1) await sleep(args.intervalMs);
      }
      const latencies = samples.filter(sample => sample.ok).map(sample => sample.latencyMs);
      const summary = {
        url: `${base}${path}`,
        rounds: samples.length,
        successes: samples.filter(sample => sample.ok).length,
        failures: samples.filter(sample => !sample.ok).length,
        consecutiveFailuresAtEnd: consecutiveFailures,
        maxConsecutiveFailures,
        latencyMs: {
          min: round(latencies.length ? Math.min(...latencies) : null),
          p50: round(percentile(latencies, 50)),
          p95: round(percentile(latencies, 95)),
          max: round(latencies.length ? Math.max(...latencies) : null),
        },
        lastBody: samples.at(-1)?.body ?? null,
        lastError: samples.at(-1)?.error ?? null,
      };
      report.probes[path] = summary;
      if (maxConsecutiveFailures >= HEALTH_MAX_CONSECUTIVE_FAILURES) {
        raise('CRITICAL', 'HEALTH_CONSECUTIVE_FAILURES', `${path} 连续 ${maxConsecutiveFailures} 次失败（阈值 ${HEALTH_MAX_CONSECUTIVE_FAILURES}）`);
      } else if (summary.failures > 0) {
        raise('WARN', 'HEALTH_INTERMITTENT_FAILURES', `${path} ${summary.failures}/${summary.rounds} 次探测失败`);
      }
      if ((summary.latencyMs.p95 ?? 0) > PROBE_P95_WARN_MS) {
        raise('WARN', 'PROBE_SLOW', `${path} p95 ${summary.latencyMs.p95}ms 超过 ${PROBE_P95_WARN_MS}ms`);
      }
    }
  } else {
    report.probes.skipped = '未提供 --base-url，跳过 HTTP 探测';
  }

  if (report.disk.exists && report.disk.freePercent !== null && report.disk.freePercent < DISK_MIN_FREE_PERCENT) {
    raise('CRITICAL', 'DISK_LOW', `数据库分区可用空间 ${report.disk.freePercent}% < ${DISK_MIN_FREE_PERCENT}%`);
  }
  if (report.database.exists) {
    if (report.database.integrityOk === false) {
      raise('CRITICAL', 'DB_INTEGRITY', `integrity_check 返回 ${JSON.stringify(report.database.integrityCheck)}`);
    }
    if (report.database.readError) {
      raise('CRITICAL', 'DB_UNREADABLE', `只读打开数据库失败: ${report.database.readError}`);
    }
    if (Array.isArray(report.database.missingTables) && report.database.missingTables.length > 0) {
      raise(
        'CRITICAL',
        'DB_SCHEMA_MISMATCH',
        `数据库缺少表 ${report.database.missingTables.join(', ')}（--database 可能指向了错误的文件，或 schema 未初始化）`,
      );
    }
    if (report.database.mainBytes > 0
        && report.database.walBytes > WAL_WARN_MIN_BYTES
        && report.database.walBytes > report.database.mainBytes * WAL_WARN_RATIO) {
      raise(
        'WARN',
        'DB_WAL_LARGE',
        `WAL ${report.database.walBytes} bytes 超过主库 ${report.database.mainBytes} bytes 的 ${WAL_WARN_RATIO} 倍`
          + `（且 > ${WAL_WARN_MIN_BYTES} bytes 下限），长期未 checkpoint`,
      );
    }
  }
  if (report.serverErrors && report.serverErrors.errorRatePercent !== null
      && report.serverErrors.errorRatePercent > ERROR_RATE_MAX_PERCENT) {
    raise('CRITICAL', 'HTTP_5XX_RATE', `5xx 比例 ${report.serverErrors.errorRatePercent}% > ${ERROR_RATE_MAX_PERCENT}%`);
  }

  if (report.alerts.length === 0) {
    report.alerts.push({ level: 'INFO', code: 'ALL_CLEAR', message: '所有阈值均未触发' });
  }
  report.ok = report.status !== 'CRITICAL';
  console.log(JSON.stringify(report, null, 2));
  if (args.report) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report.ok ? 0 : 1;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    console.error(JSON.stringify({ tool: 'ops/health-probe.mjs', ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 2;
  });
