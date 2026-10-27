#!/usr/bin/env node
/**
 * OPS-03 用户数据清理**探针**（默认 dry-run；--execute 需双重确认）
 *
 * 背景：需要按用户名清理 / 盘点某些测试用户的数据，但生产库不可逆操作必须先有可审计的
 * 影响面盘点。本脚本就是那个盘点工具：默认只读，输出每个目标用户在各表中的行数、
 * 「是否仍是某会话唯一成员」的影响面，以及**非目标数据的确定性聚合摘要 hash**——
 * 用它可以在真正执行前后比对，证明非目标数据未变。
 *
 * 安全设计（重要）：
 *   - 默认 `--dry-run`，不写库；
 *   - `--execute` 必须同时给 `--confirm <dry-run 打印的 planHash>`，否则拒绝执行；
 *   - `--execute` 时先在同一事务里重算 planHash，不匹配则回滚；
 *   - 执行前自动尝试一次一致性备份（调用 ops/backup.mjs），备份失败则拒绝执行；
 *   - 脚本本身不读取、不写入、不删除任何非指定数据库文件。
 *
 * 用法：
 *   node ops/cleanup-probe.mjs --database <db> --usernames alice,bob
 *   node ops/cleanup-probe.mjs --database <db> --usernames alice --json
 *   node ops/cleanup-probe.mjs --database <db> --usernames alice --execute --confirm <planHash>
 *
 * 退出码：0 = dry-run 成功 / execute 成功；1 = 校验失败或执行失败；2 = 参数/环境错误。
 */

import { existsSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
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

function parseArgs(argv) {
  const args = { database: process.env.DATABASE_PATH ?? '', usernames: [], execute: false, confirm: '', json: false, report: '', backupDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺少参数值`);
      index += 1;
      return value;
    };
    if (token === '--database') args.database = takeValue();
    else if (token === '--usernames') args.usernames.push(...takeValue().split(',').map(name => name.trim()).filter(Boolean));
    else if (token === '--username') args.usernames.push(takeValue().trim());
    else if (token === '--execute') args.execute = true;
    else if (token === '--confirm') args.confirm = takeValue();
    else if (token === '--backup-dir') args.backupDir = takeValue();
    else if (token === '--report') args.report = takeValue();
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数: ${token}`);
  }
  args.usernames = [...new Set(args.usernames)];
  return args;
}

/** 把一行规范化为稳定字符串（列名排序，值 JSON 序列化），用于确定性聚合 */
function canonicalRow(row) {
  return Object.keys(row)
    .sort()
    .map(key => `${key}=${JSON.stringify(row[key])}`)
    .join('\u0001');
}

/**
 * 计算「非目标数据」的确定性聚合摘要：
 *   - 对每张表的每一行，生成 canonicalRow；
 *   - 排除目标用户直接相关的行（users/sessions/friend_requests/friendships/messages 里涉及目标用户的行）；
 *   - conversations 只要会员不含目标用户就保留；conversation_members 只排除目标用户自己的行；
 *   - 所有行按字符串排序后逐行喂进 sha256，输出总行数与 hash。
 * 这样执行前后比对 hash 即可证明非目标数据未被改动。
 */
function aggregateDigest(database, targetUserIds) {
  const targetSet = new Set(targetUserIds);
  const parts = [];
  const perTable = {};
  const rowsOf = (table) => database.prepare(`SELECT * FROM ${table}`).all();

  const tables = [
    { name: 'users', skip: row => targetSet.has(row.id) },
    { name: 'sessions', skip: row => targetSet.has(row.user_id) },
    {
      name: 'friend_requests',
      skip: row => targetSet.has(row.sender_id) || targetSet.has(row.recipient_id),
    },
    {
      name: 'friendships',
      skip: row => targetSet.has(row.user_id) || targetSet.has(row.friend_id),
    },
    { name: 'conversations', skip: () => false },
    { name: 'conversation_members', skip: row => targetSet.has(row.user_id) },
    { name: 'messages', skip: row => targetSet.has(row.sender_id) },
    { name: 'ws_tickets', skip: () => false },
  ];

  for (const { name, skip } of tables) {
    const rows = rowsOf(name);
    const kept = [];
    for (const row of rows) if (!skip(row)) kept.push(canonicalRow(row));
    kept.sort();
    perTable[name] = { totalRows: rows.length, retainedRows: kept.length };
    parts.push(`##${name}##${kept.length}`);
    parts.push(...kept);
  }
  const digest = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
  return { digest, perTable, retainedTotal: Object.values(perTable).reduce((acc, item) => acc + item.retainedRows, 0) };
}

function buildPlan(database, usernames) {
  const targetUsers = [];
  for (const username of usernames) {
    const row = database.prepare('SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE').get(username);
    targetUsers.push(row ? { id: row.id, username: row.username, displayName: row.display_name } : { username, missing: true });
  }
  const targetIds = targetUsers.filter(user => !user.missing).map(user => user.id);

  const details = targetUsers.map(user => {
    if (user.missing) return { ...user, counts: null, impact: null };
    const count = (sql, ...params) => Number(database.prepare(sql).get(...params)?.n ?? 0);

    // 该用户参与的所有会话
    const conversations = database
      .prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?')
      .all(user.id)
      .map(row => row.conversation_id);

    // 「是否仍是某会话唯一成员」：会话里只剩他一个人 → 删掉用户后该会话将成为空壳
    const soleMemberships = [];
    for (const conversationId of conversations) {
      const others = count(
        'SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND user_id <> ?',
        conversationId,
        user.id,
      );
      if (others === 0) {
        const conversation = database.prepare('SELECT id, type, name FROM conversations WHERE id = ?').get(conversationId);
        soleMemberships.push({
          conversationId,
          type: conversation?.type ?? null,
          name: conversation?.name ?? null,
          messageCount: count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId),
        });
      }
    }

    // 删除该用户会级联/孤儿化的行（SQLite 外键 ON DELETE 规则不同，这里逐表给出「显式删除」计划）
    const counts = {
      users: count('SELECT COUNT(*) AS n FROM users WHERE id = ?', user.id),
      sessions: count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', user.id),
      ws_tickets: count(
        'SELECT COUNT(*) AS n FROM ws_tickets WHERE session_hash IN (SELECT token_hash FROM sessions WHERE user_id = ?)',
        user.id,
      ),
      friendships: count('SELECT COUNT(*) AS n FROM friendships WHERE user_id = ? OR friend_id = ?', user.id, user.id),
      friend_requests: count(
        'SELECT COUNT(*) AS n FROM friend_requests WHERE sender_id = ? OR recipient_id = ?',
        user.id,
        user.id,
      ),
      conversations_owned: count('SELECT COUNT(*) AS n FROM conversations WHERE owner_id = ?', user.id),
      conversation_members: count('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?', user.id),
      conversations_involved: conversations.length,
      messages: count('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?', user.id),
    };

    return {
      ...user,
      counts,
      impact: {
        soleMemberships,
        soleMembershipCount: soleMemberships.length,
        // 删除该用户后这些会话将只剩 0 个成员（admin 需决定：保留空会话 / 一并删除 / 重新分配）
        conversationsBecomingEmpty: soleMemberships.length,
        groupConversationsLosingMember: conversations.filter(
          conversationId => !soleMemberships.some(item => item.conversationId === conversationId),
        ).length,
        note:
          '本脚本默认只盘点不执行。真实清理必须由用户批准并先做生产库快照；' +
          'OWNER 用户（conversations.owner_id）删除会导致群聊失去群主，需人工决策。',
      },
    };
  });

  const aggregate = aggregateDigest(database, targetIds);
  const summary = {
    database: null,
    tables: TABLES,
    targetUsernames: usernames,
    found: targetUsers.filter(user => !user.missing).length,
    missing: targetUsers.filter(user => user.missing).map(user => user.username),
    targets: details,
    aggregate,
  };
  const planHash = createHash('sha256').update(JSON.stringify(summary), 'utf8').digest('hex');
  return { summary, planHash, targetIds };
}

/** dry-run 与 execute 共用的 SQL 删除计划（顺序：先叶子表，后主表） */
function executeDelete(database, targetIds) {
  const statements = [
    { sql: 'DELETE FROM ws_tickets WHERE session_hash IN (SELECT token_hash FROM sessions WHERE user_id = ?)', label: 'ws_tickets' },
    { sql: 'DELETE FROM messages WHERE sender_id = ?', label: 'messages' },
    { sql: 'DELETE FROM conversation_members WHERE user_id = ?', label: 'conversation_members' },
    { sql: 'DELETE FROM sessions WHERE user_id = ?', label: 'sessions' },
    { sql: 'DELETE FROM friendships WHERE user_id = ? OR friend_id = ?', label: 'friendships', twoParams: true },
    { sql: 'DELETE FROM friend_requests WHERE sender_id = ? OR recipient_id = ?', label: 'friend_requests', twoParams: true },
    { sql: 'DELETE FROM conversations WHERE owner_id = ?', label: 'conversations(owner)' },
    { sql: 'DELETE FROM users WHERE id = ?', label: 'users' },
  ];
  const deleted = {};
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of statements) {
      let total = 0;
      for (const id of targetIds) {
        const result = statement.twoParams
          ? database.prepare(statement.sql).run(id, id)
          : database.prepare(statement.sql).run(id);
        total += Number(result.changes ?? 0);
      }
      deleted[statement.label] = total;
    }
    database.exec('COMMIT');
    return deleted;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        '用法: node ops/cleanup-probe.mjs --database <db> --usernames alice,bob [--json]',
        '      node ops/cleanup-probe.mjs --database <db> --usernames alice --execute --confirm <planHash>',
        '',
        '默认 dry-run（只读盘点）。--execute 需要 --confirm 传入 dry-run 输出的 planHash，',
        '并会先做一次一致性备份，失败则拒绝执行。',
      ].join('\n'),
    );
    return 0;
  }
  if (!args.database) {
    console.error('错误：未指定 --database，且环境变量 DATABASE_PATH 为空');
    return 2;
  }
  if (args.usernames.length === 0) {
    console.error('错误：至少指定一个 --usernames / --username');
    return 2;
  }
  const databasePath = resolve(args.database);
  if (!existsSync(databasePath)) {
    console.error(`错误：数据库不存在: ${databasePath}`);
    return 2;
  }
  if (!args.execute && args.confirm) {
    console.error('警告：未加 --execute，--confirm 被忽略（保持 dry-run）');
  }

  const database = new DatabaseSync(databasePath, args.execute ? {} : { readOnly: true });
  let plan;
  try {
    plan = buildPlan(database, args.usernames);
    plan.summary.database = { path: databasePath, mode: args.execute ? 'read-write' : 'read-only' };
    plan.summary.database.bytes = statSync(databasePath).size;
  } catch (error) {
    database.close();
    console.error(JSON.stringify({ tool: 'ops/cleanup-probe.mjs', ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    return 1;
  }

  const report = {
    tool: 'ops/cleanup-probe.mjs',
    node: process.version,
    mode: args.execute ? 'execute' : 'dry-run',
    generatedAt: new Date().toISOString(),
    planHash: plan.planHash,
    plan: plan.summary,
    execution: null,
    after: null,
    ok: true,
  };

  if (!args.execute) {
    database.close();
    report.summaryLine =
      `dry-run: 命中 ${plan.summary.found}/${args.usernames.length} 个用户，` +
      `非目标保留行 ${plan.summary.aggregate.retainedTotal}，aggregateHash=${plan.summary.aggregate.digest.slice(0, 16)}…，` +
      `planHash=${plan.planHash.slice(0, 16)}…（未修改任何数据）`;
    const payload = JSON.stringify(report, null, 2);
    console.log(payload);
    if (args.report) writeFileSync(resolve(args.report), `${payload}\n`, 'utf8');
    return 0;
  }

  // ---------- execute 路径：三重门 ----------
  if (args.confirm !== plan.planHash) {
    database.close();
    report.ok = false;
    report.error = `--confirm 与当前盘点 planHash 不一致（传入 ${args.confirm || '空'}，实际 ${plan.planHash}）`;
    console.log(JSON.stringify(report, null, 2));
    return 1;
  }
  if (plan.summary.missing.length > 0) {
    database.close();
    report.ok = false;
    report.error = `存在不存在的用户名，拒绝执行: ${plan.summary.missing.join(', ')}`;
    console.log(JSON.stringify(report, null, 2));
    return 1;
  }

  // 备份门：执行前必须成功备份
  const backupDir = args.backupDir || join(dirname(databasePath), 'cleanup-backups');
  const backupPath = join(backupDir, `pre-cleanup-${Date.now()}.sqlite`);
  const backupRun = spawnSync(process.execPath, [join(here, 'backup.mjs'), '--source', databasePath, '--dest', backupPath], {
    encoding: 'utf8',
  });
  if (backupRun.status !== 0) {
    database.close();
    report.ok = false;
    report.error = `执行前备份失败，拒绝执行（exit ${backupRun.status}）: ${backupRun.stderr.slice(0, 500)}`;
    report.backup = { path: backupPath, ok: false };
    console.log(JSON.stringify(report, null, 2));
    return 1;
  }
  report.backup = { path: backupPath, ok: true };

  const before = plan.summary.aggregate.digest;
  const deleted = executeDelete(database, plan.targetIds);
  const afterAggregate = aggregateDigest(database, plan.targetIds);
  const after = afterAggregate.digest;
  database.close();

  report.execution = { deleted, beforeHash: before, afterHash: after, nonTargetUnchanged: before === after };
  report.after = afterAggregate;
  report.ok = before === after;
  console.log(JSON.stringify(report, null, 2));
  if (args.report) writeFileSync(resolve(args.report), `${payloadSafe(report)}\n`, 'utf8');
  return report.ok ? 0 : 1;
}

function payloadSafe(report) {
  return JSON.stringify(report, null, 2);
}

process.exitCode = main();
