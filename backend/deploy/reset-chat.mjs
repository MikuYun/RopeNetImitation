import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/src/db.js';
import { hashPassword } from '../dist/src/security.js';

if (process.argv[2] !== '--confirm-reset-users' || !process.env.DATABASE_PATH) {
  throw new Error('Stop the chat service and back up its database first; require DATABASE_PATH and --confirm-reset-users');
}
const databasePath = resolve(process.env.DATABASE_PATH);
if (!statSync(databasePath).isFile()) throw new Error('Existing database file required');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 4096) throw new Error('Input too large');
}
const account = JSON.parse(input);
if (typeof account.username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(account.username) ||
    typeof account.displayName !== 'string' || !account.displayName.trim() || account.displayName.trim().length > 40 ||
    typeof account.password !== 'string' || account.password.length < 8 || account.password.length > 128) {
  throw new Error('Invalid account input');
}
const passwordHash = await hashPassword(account.password);
const store = new Store(databasePath);
try {
  const tables = ['ws_tickets', 'sessions', 'messages', 'conversation_members', 'conversations', 'friend_requests', 'friendships', 'users'];
  const before = Object.fromEntries(tables.map(table => [table, store.get(`SELECT COUNT(*) AS total FROM ${table}`).total]));
  store.transaction(() => {
    for (const table of tables) store.run(`DELETE FROM ${table}`);
    store.run("DELETE FROM sqlite_sequence WHERE name = 'messages'");
    store.run('INSERT INTO users(id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      randomUUID(), account.username.toLowerCase(), account.displayName.trim(), passwordHash, new Date().toISOString());
    if (store.all('PRAGMA foreign_key_check').length) throw new Error('Foreign key check failed');
  });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const after = Object.fromEntries(tables.map(table => [table, store.get(`SELECT COUNT(*) AS total FROM ${table}`).total]));
  console.log(JSON.stringify({ databasePath, before, after, username: account.username.toLowerCase(), displayName: account.displayName.trim() }));
} finally {
  store.close();
}
