#!/usr/bin/env node
/**
 * OPS-03 探针的**夹具生成器**（只在隔离临时库里造样本数据，绝不碰生产库）
 *
 * 用途：给 `ops/cleanup-probe.mjs` 的 dry-run 提供一份带真实关系结构的样本库，
 * 用来验证影响面盘点（唯一成员会话、群主、级联关系、非目标聚合 hash）是否正确。
 *
 * 用法：
 *   node ops/seed-fixture.mjs --database <临时库路径> [--report <json>]
 *
 * 退出码：0 = 成功；1 = 失败。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../dist/src/app.js';
import { digest, hashPassword } from '../dist/src/security.js';

function parseArgs(argv) {
  const args = { database: '', report: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--database') args.database = argv[++index] ?? '';
    else if (token === '--report') args.report = argv[++index] ?? '';
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数: ${token}`);
  }
  return args;
}

const now = () => new Date().toISOString();
const addDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node ops/seed-fixture.mjs --database <临时库路径> [--report <json>]');
    return 0;
  }
  if (!args.database) {
    console.error('错误：必须指定 --database（建议放在 os.tmpdir() 下）');
    return 1;
  }
  const databasePath = resolve(args.database);
  if (existsSync(databasePath)) {
    console.error(`错误：目标已存在，拒绝覆盖: ${databasePath}`);
    return 1;
  }
  mkdirSync(dirname(databasePath), { recursive: true });

  const { app, store } = await buildApp({ databasePath, logger: false });
  await app.ready();
  try {
    const passwordHash = await hashPassword('correct horse battery staple');
    const users = [
      { username: 'alice', displayName: 'Alice' },
      { username: 'bob', displayName: 'Bob' },
      { username: 'carol', displayName: 'Carol' },
      { username: 'dave', displayName: 'Dave' },
    ];
    const ids = {};
    for (const user of users) {
      const id = randomUUID();
      ids[user.username] = id;
      store.run(
        'INSERT INTO users (id, username, display_name, avatar_url, bio, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        user.username,
        user.displayName,
        '',
        '',
        passwordHash,
        now(),
      );
      // 每个用户一条 session；alice 额外多一条（模拟多设备）
      const sessions = user.username === 'alice' ? 2 : 1;
      for (let index = 0; index < sessions; index += 1) {
        store.run(
          'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
          digest(`fixture-token-${user.username}-${index}`),
          id,
          addDays(7),
          now(),
        );
      }
    }

    // ws_tickets：alice 的设备在等一个 ticket
    store.run(
      'INSERT INTO ws_tickets (ticket_hash, session_hash, expires_at) VALUES (?, ?, ?)',
      digest('fixture-ws-ticket-alice'),
      digest('fixture-token-alice-0'),
      addDays(0.001),
    );

    // 好友关系：alice-bob 双向；alice-carol 双向；bob-carol 单向（模拟非对称残留，用于验证 OR 条件）
    const friendships = [
      ['alice', 'bob'],
      ['bob', 'alice'],
      ['alice', 'carol'],
      ['carol', 'alice'],
      ['bob', 'carol'],
    ];
    for (const [left, right] of friendships) {
      store.run('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)', ids[left], ids[right], now());
    }

    // 好友申请：dave → alice（pending，会被清理），carol → bob（accepted，非目标侧字段）
    store.run(
      'INSERT INTO friend_requests (id, sender_id, recipient_id, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(),
      ids.dave,
      ids.alice,
      '想加个好友',
      'pending',
      now(),
      now(),
    );
    store.run(
      'INSERT INTO friend_requests (id, sender_id, recipient_id, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(),
      ids.carol,
      ids.bob,
      '同事',
      'accepted',
      now(),
      now(),
    );

    // 会话 1：alice-bob 私聊（alice 删掉后只剩 bob 一人 → 「唯一成员」影响面）
    const directId = randomUUID();
    store.run(
      'INSERT INTO conversations (id, type, name, owner_id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      directId,
      'direct',
      '',
      null,
      [ids.alice, ids.bob].sort().join(':'),
      now(),
      now(),
    );
    for (const username of ['alice', 'bob']) {
      store.run(
        'INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_seq) VALUES (?, ?, ?, ?)',
        directId,
        ids[username],
        now(),
        0,
      );
    }

    // 会话 2：alice 当群主的三人群（alice 删掉后群仍在，但失去群主 → 需人工决策）
    const groupId = randomUUID();
    store.run(
      'INSERT INTO conversations (id, type, name, owner_id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      groupId,
      'group',
      '三人小组',
      ids.alice,
      null,
      now(),
      now(),
    );
    for (const username of ['alice', 'bob', 'carol']) {
      store.run(
        'INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_seq) VALUES (?, ?, ?, ?)',
        groupId,
        ids[username],
        now(),
        0,
      );
    }

    // 会话 3：bob-carol 私聊（完全不含 alice 的会话 → 非目标数据，必须 hash 不变）
    const otherId = randomUUID();
    store.run(
      'INSERT INTO conversations (id, type, name, owner_id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      otherId,
      'direct',
      '',
      null,
      [ids.bob, ids.carol].sort().join(':'),
      now(),
      now(),
    );
    for (const username of ['bob', 'carol']) {
      store.run(
        'INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_seq) VALUES (?, ?, ?, ?)',
        otherId,
        ids[username],
        now(),
        0,
      );
    }

    // 会话 4：dave 一个人的私聊（构造「唯一成员」影响面：删掉 dave 后该会话将变成空壳）
    const soloId = randomUUID();
    store.run(
      'INSERT INTO conversations (id, type, name, owner_id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      soloId,
      'direct',
      '',
      null,
      `solo:dave`,
      now(),
      now(),
    );
    store.run(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_seq) VALUES (?, ?, ?, ?)',
      soloId,
      ids.dave,
      now(),
      0,
    );

    // 消息：每个会话 seq 从 1 连续递增
    const messages = [
      [directId, 'alice', '大家好', 'text'],
      [directId, 'bob', '你好 alice', 'text'],
      [directId, 'alice', '今天有空吗', 'text'],
      [groupId, 'alice', 'Alice 创建了群聊', 'system'],
      [groupId, 'bob', '收到', 'text'],
      [otherId, 'bob', 'carol 我们单独聊', 'text'],
      [otherId, 'carol', '好的', 'text'],
      [soloId, 'dave', '自言自语', 'text'],
    ];
    const seqs = new Map();
    for (const [conversationId, username, content, type] of messages) {
      const seq = (seqs.get(conversationId) ?? 0) + 1;
      seqs.set(conversationId, seq);
      store.run(
        'INSERT INTO messages (msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        randomUUID(),
        seq,
        conversationId,
        ids[username],
        randomUUID(),
        type,
        content,
        now(),
      );
      store.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conversationId);
    }

    const report = {
      tool: 'ops/seed-fixture.mjs',
      databasePath,
      fixtureUsers: Object.keys(ids).map(username => ({ username, id: ids[username] })),
      counts: {
        users: Number(store.get('SELECT COUNT(*) AS n FROM users').n),
        sessions: Number(store.get('SELECT COUNT(*) AS n FROM sessions').n),
        ws_tickets: Number(store.get('SELECT COUNT(*) AS n FROM ws_tickets').n),
        friendships: Number(store.get('SELECT COUNT(*) AS n FROM friendships').n),
        friend_requests: Number(store.get('SELECT COUNT(*) AS n FROM friend_requests').n),
        conversations: Number(store.get('SELECT COUNT(*) AS n FROM conversations').n),
        conversation_members: Number(store.get('SELECT COUNT(*) AS n FROM conversation_members').n),
        messages: Number(store.get('SELECT COUNT(*) AS n FROM messages').n),
      },
      ok: true,
    };
    console.log(JSON.stringify(report, null, 2));
    if (args.report) writeFileSync(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`seed-fixture 失败: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  },
);
