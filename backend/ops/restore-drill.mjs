#!/usr/bin/env node
/**
 * OPS-01 备份 + 恢复演练（RTO/RPO 实测）
 *
 * 流程（全部在系统临时目录的隔离库里做，不碰任何真实库）：
 *   1. 用真实服务代码 `backend/dist/src/app.js` 的 buildApp() 起一个源库应用；
 *   2. 通过真实 REST API 造数据：注册用户 → 好友申请/接受 → 私聊 → 发消息 → 建群（system 消息占 seq）；
 *   3. **在源应用仍然打开（WAL 有活动连接）时** 调用 ops/backup.mjs 做在线备份，
 *      验证备份里包含 WAL 中已提交但未 checkpoint 的数据；
 *   4. 关闭源应用 → 把备份复制到新路径 → buildApp({databasePath: 恢复路径}) 起恢复实例；
 *   5. 在恢复实例上验证：登录成功、历史消息逐条一致、续发消息 seq 严格接续、integrity_check=ok；
 *   6. 输出实测 RTO（从开始恢复到服务可用+验证通过）与 RPO 说明。
 *
 * 用法：node ops/restore-drill.mjs [--keep] [--json]
 *   --keep  保留临时目录（默认演练结束删除）
 * 退出码：0 = 全部检查通过；1 = 有检查失败；2 = 环境/参数错误。
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildApp } from '../dist/src/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const ORIGIN = 'http://localhost:5173';

const args = process.argv.slice(2);
const keep = args.includes('--keep');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) process.exitCode = 1;
  return ok;
}

async function api(app, method, url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...headers },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  let body = null;
  try {
    body = response.body ? response.json() : null;
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, headers: response.headers, body };
}

function runBackup(sourcePath, destPath, reportPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [join(here, 'backup.mjs'), '--source', sourcePath, '--dest', destPath, '--report', reportPath],
      { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', code => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'aitrance-restore-'));
  const sourcePath = join(root, 'source.sqlite');
  const backupPath = join(root, 'backup', 'snapshot.sqlite');
  const restoredPath = join(root, 'restored', 'restored.sqlite');
  const reportPath = join(root, 'backup-report.json');

  const report = {
    tool: 'ops/restore-drill.mjs',
    node: process.version,
    startedAt: new Date().toISOString(),
    tempRoot: root,
    ports: null,
    data: {},
    backup: null,
    restore: {},
    checks,
    rtoSeconds: null,
    rpo: null,
    ok: false,
  };

  let sourceApp = null;
  let restoredApp = null;
  try {
    // ---------- 1. 源实例 ----------
    const buildStart = performance.now();
    sourceApp = await buildApp({ databasePath: sourcePath, logger: false });
    await sourceApp.app.ready();
    report.buildSourceAppMs = Math.round(performance.now() - buildStart);

    // ---------- 2. 造数据（真实 REST API） ----------
    const password = 'password123';
    const names = ['alice', 'bob', 'carol'];
    const users = {};
    for (const name of names) {
      const response = await api(sourceApp.app, 'POST', '/api/v1/auth/register', {
        payload: { username: name, password, displayName: name.toUpperCase() },
      });
      check(`注册 ${name} → 201`, response.status === 201, { status: response.status, body: response.body });
      users[name] = { id: response.body.user.id, token: response.body.token };
    }

    // alice 加 bob、carol 为好友
    for (const friend of ['bob', 'carol']) {
      const created = await api(sourceApp.app, 'POST', '/api/v1/friend-requests', {
        token: users.alice.token,
        payload: { userId: users[friend].id, note: 'drill' },
      });
      check(`好友申请 alice→${friend} → 201`, created.status === 201, { status: created.status, body: created.body });
      const resolved = await api(sourceApp.app, 'POST', `/api/v1/friend-requests/${created.body.id}/respond`, {
        token: users[friend].token,
        payload: { action: 'accept' },
      });
      check(`接受好友申请 alice↔${friend} → 200`, resolved.status === 200, { status: resolved.status });
    }

    // 私聊
    const direct = await api(sourceApp.app, 'POST', '/api/v1/conversations/direct', {
      token: users.alice.token,
      payload: { userId: users.bob.id },
    });
    check('创建私聊 alice↔bob → 200', direct.status === 200, { status: direct.status });
    const directId = direct.body.id;

    // 发 10 条消息（交替发送，验证 seq 严格递增）
    const sent = [];
    for (let index = 0; index < 10; index += 1) {
      const sender = index % 2 === 0 ? users.alice : users.bob;
      const response = await api(sourceApp.app, 'POST', `/api/v1/conversations/${directId}/messages`, {
        token: sender.token,
        payload: { clientMsgId: crypto.randomUUID(), type: 'text', content: `drill-msg-${index}` },
      });
      check(`私聊消息 #${index} → 201`, response.status === 201, { status: response.status, body: response.body });
      sent.push(response.body);
    }

    // 群聊（会产生 system 消息，system 消息也占 seq）
    const group = await api(sourceApp.app, 'POST', '/api/v1/conversations/group', {
      token: users.alice.token,
      payload: { name: 'drill-group', memberIds: [users.bob.id, users.carol.id] },
    });
    check('创建群聊 → 201', group.status === 201, { status: group.status, body: group.body });
    const groupId = group.body.id;
    await api(sourceApp.app, 'POST', `/api/v1/conversations/${groupId}/messages`, {
      token: users.carol.token,
      payload: { clientMsgId: crypto.randomUUID(), type: 'text', content: 'drill-group-0' },
    });

    // 源库快照（直接读 store，验证备份前后一致性）
    const snapshot = {
      users: sourceApp.store.get('SELECT COUNT(*) AS n FROM users').n,
      sessions: sourceApp.store.get('SELECT COUNT(*) AS n FROM sessions').n,
      friendships: sourceApp.store.get('SELECT COUNT(*) AS n FROM friendships').n,
      conversations: sourceApp.store.get('SELECT COUNT(*) AS n FROM conversations').n,
      messages: sourceApp.store.get('SELECT COUNT(*) AS n FROM messages').n,
      maxMessageId: sourceApp.store.get('SELECT COALESCE(MAX(id), 0) AS n FROM messages').n,
      maxSeq: sourceApp.store.get('SELECT COALESCE(MAX(seq), 0) AS n FROM messages').n,
      directMaxSeq: sourceApp.store.get('SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE conversation_id = ?', directId).n,
      groupMaxSeq: sourceApp.store.get('SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE conversation_id = ?', groupId).n,
      userVersion: sourceApp.store.get('PRAGMA user_version').user_version,
      walBytesLive: existsSync(`${sourcePath}-wal`) ? statSync(`${sourcePath}-wal`).size : 0,
      mainBytesLive: existsSync(sourcePath) ? statSync(sourcePath).size : 0,
    };
    report.data.sourceSnapshot = snapshot;
    report.data.directId = directId;
    report.data.groupId = groupId;

    // 记录源端历史（用于恢复后逐条对比）
    const historyBefore = await api(sourceApp.app, 'GET', `/api/v1/conversations/${directId}/messages?limit=100`, {
      token: users.alice.token,
    });
    const sourceHistory = historyBefore.body.items.map(item => `${item.seq}:${item.senderId}:${item.content}`);
    report.data.sourceHistoryCount = sourceHistory.length;

    // ---------- 3. 在线备份（源应用仍打开，WAL 有活动连接） ----------
    const backupStart = performance.now();
    const backupRun = await runBackup(sourcePath, backupPath, reportPath);
    const backupMs = Math.round(performance.now() - backupStart);
    check('备份子进程退出码 = 0', backupRun.code === 0, { code: backupRun.code, stderr: backupRun.stderr.trim() });
    check('备份文件存在', existsSync(backupPath), { path: backupPath });
    if (!existsSync(backupPath)) throw new Error('备份文件不存在，后续演练无法继续');

    const backupReport = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    report.backup = {
      durationMs: backupMs,
      fileBytes: statSync(backupPath).size,
      report: backupReport
        ? {
            method: backupReport.method,
            integrity: backupReport.integrity,
            countsMatch: backupReport.countsMatch,
            sourceSnapshot: backupReport.sourceSnapshot,
            backup: backupReport.backup
              ? { bytes: backupReport.backup.bytes, shasum: backupReport.backup.shasum, counts: backupReport.backup.counts, maxSeq: backupReport.backup.maxSeq }
              : null,
          }
        : null,
    };
    check('备份方法为 node:sqlite backup()', backupReport?.method === 'node:sqlite backup()', { method: backupReport?.method });
    check('备份 integrity_check=ok', backupReport?.integrity?.ok === true, backupReport?.integrity);
    check('备份与源库计数一致', backupReport?.countsMatch === true, { countsMatch: backupReport?.countsMatch });
    check(
      '备份包含 WAL 中已提交数据（maxSeq 一致）',
      backupReport?.backup?.maxSeq === snapshot.maxSeq,
      { backupMaxSeq: backupReport?.backup?.maxSeq, sourceMaxSeq: snapshot.maxSeq },
    );

    // ---------- 4. 关闭源实例后恢复 ----------
    await sourceApp.app.close();
    sourceApp = null;

    const rtoStart = performance.now();
    mkdirSync(dirname(restoredPath), { recursive: true });
    copyFileSync(backupPath, restoredPath);
    restoredApp = await buildApp({ databasePath: restoredPath, logger: false });
    await restoredApp.app.ready();

    // 4a. 恢复库完整性
    const restoreDb = new DatabaseSync(restoredPath, { readOnly: true });
    let integrityRows;
    let restoredCounts;
    try {
      integrityRows = restoreDb.prepare('PRAGMA integrity_check').all().map(row => String(Object.values(row)[0]));
      restoredCounts = {
        users: restoreDb.prepare('SELECT COUNT(*) AS n FROM users').get().n,
        sessions: restoreDb.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
        friendships: restoreDb.prepare('SELECT COUNT(*) AS n FROM friendships').get().n,
        conversations: restoreDb.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
        messages: restoreDb.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
        journalMode: restoreDb.prepare('PRAGMA journal_mode').get().journal_mode,
        userVersion: restoreDb.prepare('PRAGMA user_version').get().user_version,
      };
    } finally {
      restoreDb.close();
    }
    check('恢复库 integrity_check=ok', integrityRows.length === 1 && integrityRows[0] === 'ok', integrityRows);
    check(
      '恢复库行数与源库一致',
      JSON.stringify(restoredCounts.users) === JSON.stringify(snapshot.users) &&
        JSON.stringify(restoredCounts.messages) === JSON.stringify(snapshot.messages) &&
        JSON.stringify(restoredCounts.conversations) === JSON.stringify(snapshot.conversations),
      { restoredCounts, sourceSnapshot: snapshot },
    );

    // 4b. 恢复实例上登录（验证 password_hash / sessions 都完整）
    const login = await api(restoredApp.app, 'POST', '/api/v1/auth/login', {
      payload: { username: 'alice', password },
    });
    check('恢复实例登录成功 → 200', login.status === 200, { status: login.status, body: login.body });
    const token = login.body?.token;
    check('登录返回 43 字符 Bearer token', typeof token === 'string' && token.length === 43, { tokenLength: token?.length });

    // 4c. 历史消息逐条一致
    const historyAfter = await api(restoredApp.app, 'GET', `/api/v1/conversations/${directId}/messages?limit=100`, {
      token,
    });
    const restoredHistory = historyAfter.body.items.map(item => `${item.seq}:${item.senderId}:${item.content}`);
    check(
      '恢复后历史消息逐条一致',
      JSON.stringify(sourceHistory) === JSON.stringify(restoredHistory),
      { source: sourceHistory.length, restored: restoredHistory.length },
    );

    // 4d. 续发消息 seq 严格接续（私聊 maxSeq+1）
    const next = await api(restoredApp.app, 'POST', `/api/v1/conversations/${directId}/messages`, {
      token,
      payload: { clientMsgId: crypto.randomUUID(), type: 'text', content: 'drill-after-restore' },
    });
    check('恢复后续发消息 → 201', next.status === 201, { status: next.status, body: next.body });
    check(
      '续发消息 seq = 源库 maxSeq + 1',
      next.body?.seq === snapshot.directMaxSeq + 1,
      { got: next.body?.seq, expected: snapshot.directMaxSeq + 1 },
    );

    // 4e. 群聊 seq 也接续（含 system 消息）
    const groupNext = await api(restoredApp.app, 'POST', `/api/v1/conversations/${groupId}/messages`, {
      token,
      payload: { clientMsgId: crypto.randomUUID(), type: 'text', content: 'drill-group-after-restore' },
    });
    check('恢复后群聊续发 → 201', groupNext.status === 201, { status: groupNext.status });
    check(
      '群聊续发 seq = 源库 groupMaxSeq + 1',
      groupNext.body?.seq === snapshot.groupMaxSeq + 1,
      { got: groupNext.body?.seq, expected: snapshot.groupMaxSeq + 1 },
    );

    const rtoMs = performance.now() - rtoStart;
    report.rtoSeconds = Number((rtoMs / 1000).toFixed(3));
    report.rtoBreakdown = {
      definition: '从开始恢复（复制备份文件）到恢复实例可登录 + 历史校验 + 续发消息通过',
      totalMs: Math.round(rtoMs),
    };
    report.restore = { path: restoredPath, counts: restoredCounts, integrity: integrityRows };
    report.rpo = {
      statement:
        '本库是单文件 SQLite，恢复点 = 最近一次成功备份的时刻。RPO 完全取决于备份调度的间隔，' +
        '脚本本身不提供连续复制/PITR。当前生产侧尚未部署定时备份调度 → RPO 实际未定义（BLOCK）。',
      lastSuccessfulBackupAt: new Date().toISOString(),
      walCommittedDataIncluded: true,
    };

    report.ok = checks.every(item => item.ok);
    return report;
  } finally {
    if (restoredApp) await restoredApp.app.close().catch(() => {});
    if (sourceApp) await sourceApp.app.close().catch(() => {});
    if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(report => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  })
  .catch(error => {
    console.error(JSON.stringify({ tool: 'ops/restore-drill.mjs', ok: false, error: error instanceof Error ? error.message : String(error), stack: error?.stack }, null, 2));
    process.exitCode = 1;
  });
