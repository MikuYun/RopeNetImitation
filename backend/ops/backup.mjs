#!/usr/bin/env node
/**
 * OPS-01 一致性备份脚本（aitrance-chat SQLite / WAL）
 *
 * 用途：对一个正在运行的 WAL 模式 SQLite 库做在线一致性备份，输出可审计的 JSON 报告。
 *
 * 备份方式（按优先级自动回退）：
 *   1. node:sqlite 模块级 `backup(db, dest)` —— SQLite Online Backup API，
 *      对 WAL 里已提交但尚未 checkpoint 的数据也是安全的（实测见 evidence/ops.md）。
 *   2. `VACUUM INTO 'dest'` —— 需要以可写连接打开源库；在备份 API 不可用时回退。
 *
 * 只读源库：方式 1 用 `new DatabaseSync(src, { readOnly: true })` 打开，
 * 不会写源库、不触发 checkpoint、不会阻塞写者。
 *
 * 用法：
 *   node ops/backup.mjs --source <源库路径> --dest <备份文件路径> [--report <json路径>] [--json]
 *   node ops/backup.mjs                # 默认 --source=$DATABASE_PATH
 *
 * 退出码：0 = 备份成功且 integrity_check=ok；1 = 备份或校验失败；2 = 参数/环境错误。
 *
 * 注意：本脚本不删除、不移动源库；不接触任何生产路径（只读打开 + 写备份文件）。
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqlite from 'node:sqlite';

const TABLES = [
  'users',
  'sessions',
  'friend_requests',
  'friendships',
  'conversations',
  'conversation_members',
  'messages',
  'ws_tickets',
];

function usage() {
  return [
    '用法: node ops/backup.mjs --source <db> --dest <backup.db> [--report <file.json>] [--json]',
    '  --source  源 SQLite 库路径（默认 $DATABASE_PATH）',
    '  --dest    备份输出路径（若已存在会被覆盖）',
    '  --report  额外把 JSON 报告写到文件',
    '  --json    只在 stdout 输出 JSON（默认也是 JSON）',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { source: process.env.DATABASE_PATH ?? '', dest: '', report: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--source' || token === '--dest' || token === '--report') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺少参数值`);
      args[token.slice(2)] = value;
      index += 1;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`未知参数: ${token}`);
    }
  }
  return args;
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function existingTables(database) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => String(row.name)),
  );
}

function tableCounts(database) {
  const present = existingTables(database);
  const counts = {};
  for (const table of TABLES) {
    if (!present.has(table)) {
      counts[table] = null;
      continue;
    }
    const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

function databaseSummary(database) {
  const present = existingTables(database);
  const userVersion = database.prepare('PRAGMA user_version').get()?.user_version ?? null;
  const journalMode = database.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null;
  const lastMessage = present.has('messages')
    ? database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get()
    : null;
  const lastSeq = present.has('messages')
    ? database.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages').get()
    : null;
  return {
    userVersion: Number(userVersion),
    journalMode: String(journalMode),
    counts: tableCounts(database),
    maxMessageId: Number(lastMessage?.id ?? 0),
    maxSeq: Number(lastSeq?.seq ?? 0),
  };
}

function integrityCheck(database) {
  // integrity_check 可能返回多行；全部为 'ok' 才算通过
  const rows = database.prepare('PRAGMA integrity_check').all();
  const messages = rows.map(row => String(row.integrity_check ?? Object.values(row)[0] ?? ''));
  return { ok: messages.length === 1 && messages[0] === 'ok', details: messages };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.source) {
    console.error('错误：未指定 --source，且环境变量 DATABASE_PATH 为空');
    return 2;
  }
  if (!args.dest) {
    console.error('错误：未指定 --dest');
    return 2;
  }

  const source = resolve(args.source);
  const dest = resolve(args.dest);
  if (!existsSync(source)) {
    console.error(`错误：源库不存在: ${source}`);
    return 2;
  }
  if (source === dest) {
    console.error('错误：--dest 不能与 --source 相同');
    return 2;
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) rmSync(dest, { force: true });

  const sourceStat = statSync(source);
  const walPath = `${source}-wal`;
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
  const sourceShasum = await sha256File(source);

  const result = {
    tool: 'ops/backup.mjs',
    node: process.version,
    startedAt: new Date().toISOString(),
    source: { path: source, bytes: sourceStat.size, walBytes, shasum: sourceShasum },
    dest: { path: dest },
    method: null,
    fallbackReason: null,
    sourceSnapshot: null,
    backup: null,
    durationMs: 0,
    integrity: null,
    countsMatch: null,
    ok: false,
    error: null,
  };

  const startedAtMs = performance.now();
  let sourceDb = null;
  try {
    // 以只读方式打开源库：对 WAL 已提交数据可见，且不会触发 checkpoint / 不阻塞写者
    sourceDb = new DatabaseSync(source, { readOnly: true });
    result.sourceSnapshot = databaseSummary(sourceDb);
  } catch (error) {
    result.error = `只读打开源库失败: ${error instanceof Error ? error.message : String(error)}`;
    if (sourceDb) sourceDb.close();
    result.durationMs = Math.round(performance.now() - startedAtMs);
    console.log(JSON.stringify(result, null, 2));
    return 1;
  }

  try {
    const backupApi = sqlite.backup;
    if (typeof backupApi === 'function') {
      await backupApi(sourceDb, dest);
      result.method = 'node:sqlite backup()';
    } else {
      result.fallbackReason = 'node:sqlite 未导出 backup()';
      throw new Error('__fallback__');
    }
  } catch (error) {
    if (!result.fallbackReason) {
      result.fallbackReason = error instanceof Error ? error.message : String(error);
    }
    try {
      // 回退：VACUUM INTO（需要可写连接；会短暂拿写锁，但产物是干净一致的完整库）
      if (existsSync(dest)) rmSync(dest, { force: true });
      const writable = new DatabaseSync(source);
      try {
        writable.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
      } finally {
        writable.close();
      }
      result.method = 'VACUUM INTO';
    } catch (fallbackError) {
      result.error =
        `备份失败: 首选方式 (${result.fallbackReason}) / 回退 VACUUM INTO 也失败: ` +
        `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
      result.durationMs = Math.round(performance.now() - startedAtMs);
      sourceDb.close();
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }
  }

  try {
    if (!existsSync(dest)) throw new Error('备份文件未生成');
    const destStat = statSync(dest);
    const destShasum = await sha256File(dest);
    const restored = new DatabaseSync(dest, { readOnly: true });
    let backupSnapshot;
    let integrity;
    try {
      backupSnapshot = databaseSummary(restored);
      integrity = integrityCheck(restored);
    } finally {
      restored.close();
    }
    result.backup = {
      path: dest,
      bytes: destStat.size,
      shasum: destShasum,
      ...backupSnapshot,
    };
    result.integrity = integrity;
    result.countsMatch =
      JSON.stringify(result.sourceSnapshot.counts) === JSON.stringify(backupSnapshot.counts) &&
      result.sourceSnapshot.maxSeq === backupSnapshot.maxSeq &&
      result.sourceSnapshot.maxMessageId === backupSnapshot.maxMessageId;
    result.ok = integrity.ok && result.countsMatch;
    // 备份分区剩余空间（可观测性）
    const fsStat = statfsSync(dirname(dest));
    const availableBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
    const totalBytes = Number(fsStat.blocks) * Number(fsStat.bsize);
    result.destFreePercent = totalBytes > 0 ? Number(((availableBytes / totalBytes) * 100).toFixed(1)) : null;
  } catch (error) {
    result.error = `校验备份失败: ${error instanceof Error ? error.message : String(error)}`;
    result.ok = false;
  } finally {
    if (sourceDb) {
      try {
        sourceDb.close();
      } catch {
        /* ignore */
      }
    }
    result.durationMs = Math.round(performance.now() - startedAtMs);
    result.finishedAt = new Date().toISOString();
  }

  const payload = JSON.stringify(result, null, 2);
  console.log(payload);
  if (args.report) {
    mkdirSync(dirname(resolve(args.report)), { recursive: true });
    writeFileSync(resolve(args.report), `${payload}\n`, 'utf8');
  }
  return result.ok ? 0 : 1;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    console.error(JSON.stringify({ tool: 'ops/backup.mjs', ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
