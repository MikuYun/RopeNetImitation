import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_VERSION, Store } from '../src/db.ts';

/**
 * db.ts 迁移的单元覆盖（不经过 buildApp，避免与 HTTP 层耦合）：
 * 老库重建、附件数据搬迁、两次打开幂等、新库直达最新版本。
 *
 * 每个用例用 mkdtemp 建独立目录，并用 try/finally 显式 close 后再删：
 * Windows 上库文件被打开的句柄锁着，删目录会 EBUSY，不能只靠 after 钩子的注册顺序。
 */

const userVersion = (db: DatabaseSync): number =>
  Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0);

const tableSql = (db: DatabaseSync, table: string): string =>
  ((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql) ?? '';

const names = (db: DatabaseSync, type: 'table' | 'index'): Set<string> =>
  new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}'`).all() as Array<{ name: string }>).map(row => String(row.name)));

const count = (db: DatabaseSync, sql: string, ...params: string[]): number =>
  Number((db.prepare(sql).get(...params) as { n: number }).n);

/** 在独立临时目录里跑一个用例：fn 负责自己打开/关闭连接，结束后删目录。 */
async function withTempDir(operation: (databasePath: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aitrance-migration-'));
  try {
    await operation(join(dir, 'chat.sqlite'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** v1 形态：消息只有 text/system，没有任何附件列，也没有 uploads/message_pins/posts。 */
function createV1Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
      name TEXT NOT NULL, owner_id TEXT REFERENCES users(id), direct_key TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), joined_at TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id, user_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id), client_message_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system')),
      content TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
    );
    CREATE TABLE ws_tickets (
      ticket_hash TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'alice', 'Alice', 'salt:hash', now);
  db.prepare('INSERT INTO conversations(id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', 'direct', 'dm', now, now);
  const insert = db.prepare('INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('m1', 1, 'c1', 'u1', 'cm1', 'text', 'hello', now);
  insert.run('m2', 2, 'c1', 'u1', 'cm2', 'system', 'joined', now);
  return db;
}

/** v3 形态：messages 有 attachment_id，uploads.kind 只允许 image|file。 */
function createV3Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, uid INTEGER,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'banned')), muted_until TEXT
    );
    CREATE UNIQUE INDEX users_uid ON users(uid) WHERE uid IS NOT NULL;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
      name TEXT NOT NULL, owner_id TEXT REFERENCES users(id), avatar_url TEXT NOT NULL DEFAULT '',
      direct_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), joined_at TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
      PRIMARY KEY(conversation_id, user_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id), client_message_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'image', 'file')),
      content TEXT NOT NULL, attachment_id TEXT REFERENCES uploads(id), created_at TEXT NOT NULL,
      UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
    );
    CREATE TABLE uploads (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('image', 'file')), created_at TEXT NOT NULL
    );
    CREATE TABLE message_pins (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      msg_id TEXT NOT NULL, pinned_by TEXT NOT NULL REFERENCES users(id), pinned_at TEXT NOT NULL,
      UNIQUE(conversation_id, msg_id)
    );
    PRAGMA user_version = 3;
  `);
  const now = new Date().toISOString();
  const insertUser = db.prepare('INSERT INTO users(id, uid, username, display_name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertUser.run('u1', 1001, '1001', '系统管理员', 'salt:hash', 'admin', 'active', now);
  insertUser.run('u2', 10001, 'alice', 'Alice', 'salt:hash', 'user', 'active', now);
  db.prepare('INSERT INTO conversations(id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', 'direct', 'dm', now, now);
  const insertUpload = db.prepare('INSERT INTO uploads(id, owner_id, name, mime_type, size, sha256, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertUpload.run('att-img', 'u2', 'a.png', 'image/png', 10, 'sha', 'image', now);
  insertUpload.run('att-file', 'u2', 'b.pdf', 'application/pdf', 20, 'sha', 'file', now);
  const insertMessage = db.prepare(
    'INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, attachment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertMessage.run('m-text', 1, 'c1', 'u2', 'cm1', 'text', 'hello', null, now);
  insertMessage.run('m-image', 2, 'c1', 'u2', 'cm2', 'image', 'pic', 'att-img', now);
  insertMessage.run('m-file', 3, 'c1', 'u2', 'cm3', 'file', 'doc', 'att-file', now);
  return db;
}

test('全新空库直接建到 SCHEMA_VERSION，且包含 v4 的全部表与索引', async () => {
  await withTempDir(path => {
    const store = new Store(path);
    try {
      assert.equal(SCHEMA_VERSION, 4);
      assert.equal(userVersion(store.db), SCHEMA_VERSION);
      const tables = names(store.db, 'table');
      for (const table of ['users', 'sessions', 'friend_requests', 'friendships', 'conversations',
        'conversation_members', 'messages', 'uploads', 'message_attachments', 'message_pins', 'ws_tickets',
        'posts', 'post_attachments', 'post_likes', 'post_comments']) {
        assert.ok(tables.has(table), `缺少表 ${table}`);
      }
      const indexes = names(store.db, 'index');
      for (const index of ['messages_conversation', 'uploads_owner', 'message_attachments_attachment',
        'posts_feed', 'posts_author', 'post_attachments_attachment', 'post_comments_feed']) {
        assert.ok(indexes.has(index), `缺少索引 ${index}`);
      }
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      store.close();
    }
  });
});

test('v1 老库升到 v4：数据不丢、messages 重建掉 attachment_id、新表就位', async () => {
  await withTempDir(path => {
    const legacy = createV1Database(path);
    const messagesBefore = count(legacy, 'SELECT COUNT(*) AS n FROM messages');
    legacy.close();

    const store = new Store(path);
    try {
      assert.equal(userVersion(store.db), SCHEMA_VERSION);
      assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM messages'), messagesBefore);
      const sql = tableSql(store.db, 'messages');
      assert.ok(sql.includes('recalled_at'), 'messages 应有 recalled_at 列');
      assert.ok(sql.includes('reply_to_msg_id'), 'messages 应有 reply_to_msg_id 列');
      assert.ok(!sql.includes('attachment_id'), 'messages 不应再有 attachment_id 列');
      assert.ok(sql.includes("'video'") && sql.includes("'mixed'"), 'messages.type CHECK 应包含 video/mixed');
      assert.ok(tableSql(store.db, 'uploads').includes("'video'"), 'uploads.kind CHECK 应包含 video');
      // 普通用户的 uid 必须被回填（v1 没有这一列）。
      assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM users WHERE uid IS NULL'), 0);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      store.close();
    }
  });
});

test('v3 老库升到 v4：旧 messages.attachment_id 搬进 message_attachments(position=0) 且 type 跟随 kind', async () => {
  await withTempDir(path => {
    createV3Database(path).close();

    const store = new Store(path);
    try {
      assert.equal(userVersion(store.db), SCHEMA_VERSION);
      // node:sqlite 返回 null-prototype 对象，比较前先转成普通对象。
      const rows = store.db.prepare('SELECT msg_id, attachment_id, position FROM message_attachments ORDER BY msg_id').all()
        .map(row => ({ ...row } as { msg_id: string; attachment_id: string; position: number }));
      assert.deepEqual(rows, [
        { msg_id: 'm-file', attachment_id: 'att-file', position: 0 },
        { msg_id: 'm-image', attachment_id: 'att-img', position: 0 },
      ]);
      const typeOf = (msgId: string): string =>
        String((store.db.prepare('SELECT type FROM messages WHERE msg_id = ?').get(msgId) as { type: string }).type);
      assert.equal(typeOf('m-text'), 'text');
      assert.equal(typeOf('m-image'), 'image');
      assert.equal(typeOf('m-file'), 'file');
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);

      // uploads.kind 现在接受 video；messages.type 接受 video/mixed。
      const now = new Date().toISOString();
      store.run('INSERT INTO uploads(id, owner_id, name, mime_type, size, sha256, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'att-video', 'u2', 'v.mp4', 'video/mp4', 30, 'sha', 'video', now);
      store.run('INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'm-video', 4, 'c1', 'u2', 'cm4', 'video', 'clip', now);
      store.run('INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'm-mixed', 5, 'c1', 'u2', 'cm5', 'mixed', 'mix', now);
    } finally {
      store.close();
    }
  });
});

test('已升级的库再次打开是完全 no-op（幂等）', async () => {
  await withTempDir(path => {
    createV3Database(path).close();

    const first = new Store(path);
    let snapshot: { version: number; messages: number; attachments: number; schema: string };
    try {
      snapshot = {
        version: userVersion(first.db),
        messages: count(first.db, 'SELECT COUNT(*) AS n FROM messages'),
        attachments: count(first.db, 'SELECT COUNT(*) AS n FROM message_attachments'),
        schema: tableSql(first.db, 'messages'),
      };
    } finally {
      first.close();
    }

    const second = new Store(path);
    try {
      assert.equal(userVersion(second.db), snapshot.version);
      assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM messages'), snapshot.messages);
      assert.equal(count(second.db, 'SELECT COUNT(*) AS n FROM message_attachments'), snapshot.attachments);
      assert.equal(tableSql(second.db, 'messages'), snapshot.schema);
    } finally {
      second.close();
    }
  });
});
