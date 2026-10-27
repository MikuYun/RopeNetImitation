#!/usr/bin/env node
/**
 * reset-db.mjs —— 把数据库恢复成「干净但可登录」的初始状态：清空全部业务数据，重建两个初始账号
 * （系统管理员 + 初始普通用户）。
 *
 * 用法（在 backend/ 下）：
 *   node scripts/reset-db.mjs --dry-run            # 只打印将执行的动作与各表计数，不写库
 *   node scripts/reset-db.mjs --confirm            # 真正执行
 *   node scripts/reset-db.mjs --confirm --database ../.data/chat.sqlite --uploads-dir ../.data/uploads
 *   node scripts/reset-db.mjs --confirm --no-uploads-cleanup   # 保留磁盘上的上传文件
 *
 * 为什么要有它：体验版需要「一键回到干净状态」给测试/演示用，而且要保证清完之后
 * 仍然能用 root / ADMIN_INITIAL_PASSWORD 登录（否则脚本等于把环境锁死）。
 *
 * 设计约束（不要随意放宽）：
 * - 必须显式 --confirm 才写库。不带就打印用法并 exit 1 —— 这个脚本一条命令删光所有用户数据，
 *   不能靠「手滑回车」触发。
 * - 纯 node，不依赖任何第三方包：只 import node: 内置模块。运维机器上可能没有 pnpm install。
 * - 库路径默认由脚本自身位置推导（backend/.data/chat.sqlite），不依赖 cwd —— 在哪执行都一样。
 * - 密码哈希必须与 backend/src/security.ts 的 hashPassword 逐字节一致，否则清完库就登不进去。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, '..');

/**
 * 删除顺序 = 子表在前、父表在后（外键方向）。
 * 虽然执行时外键是关掉的（见 PRAGMA foreign_keys = OFF 处的注释），但这个顺序仍然是
 * 「万一外键没关成功」时的安全网，也让脚本本身的意图一目了然。
 */
const BUSINESS_TABLES = [
  'ws_tickets',
  'post_likes',
  'post_comments',
  'post_attachments',
  'posts',
  'message_pins',
  'message_attachments',
  'messages',
  'conversation_members',
  'conversations',
  'friend_requests',
  'friendships',
  'sessions',
  'uploads',
  'users',
];

/** uploads 目录里允许被当作「本项目的上传文件」删掉的扩展名（见 upload.ts 的 EXTENSIONS）。 */
const UPLOAD_EXTENSIONS = new Set(['.png', '.jpg', '.webp', '.gif', '.pdf', '.zip', '.txt', '.mp4', '.webm', '.bin']);

const USAGE = `用法: node scripts/reset-db.mjs --confirm [选项]

清空数据库里全部业务数据，重建两个初始账号：
  管理员    uid=${process.env.ADMIN_UID ?? 1001} / ${process.env.ADMIN_USERNAME ?? 'root'}
  普通用户  uid=${process.env.SEED_USER_UID ?? 10001} / ${process.env.SEED_USER_USERNAME ?? 'qjq'}

选项:
  --confirm              必需。没有它脚本只打印用法并退出（退出码 1）。
  --dry-run              只打印将执行的动作与各表计数，不写库、不删文件。
  --database <path>      数据库路径（相对路径按 backend/ 解析，与 cwd 无关）。默认 backend/.data/chat.sqlite。
  --uploads-dir <dir>    上传文件目录（相对路径按 backend/ 解析）。默认与数据库同目录的 uploads/。
  --no-uploads-cleanup   不清理孤儿上传文件（默认清理）。
  -h, --help             打印本帮助。

环境变量（可选）: DATABASE_PATH、ADMIN_UID、ADMIN_USERNAME、ADMIN_INITIAL_PASSWORD、
                  SEED_USER_UID、SEED_USER_USERNAME、SEED_USER_DISPLAY_NAME、SEED_USER_INITIAL_PASSWORD。
`;

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

function parseArgs(argv) {
  const options = { confirm: false, dryRun: false, help: false, cleanUploads: true, database: null, uploadsDir: null };
  const takeValue = (index, flag) => {
    const inline = argv[index].includes('=') ? argv[index].slice(argv[index].indexOf('=') + 1) : null;
    if (inline !== null) return [inline, index];
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) fail(`${flag} 需要一个参数值`);
    return [next, index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (flag) {
      case '--confirm': options.confirm = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--no-uploads-cleanup': options.cleanUploads = false; break;
      case '--help': case '-h': options.help = true; break;
      case '--database': {
        const [value, consumed] = takeValue(i, '--database');
        options.database = value;
        i = consumed;
        break;
      }
      case '--uploads-dir': {
        const [value, consumed] = takeValue(i, '--uploads-dir');
        options.uploadsDir = value;
        i = consumed;
        break;
      }
      default:
        if (arg.startsWith('-')) fail(`未知参数: ${arg}`);
    }
  }
  return options;
}

/**
 * 与 backend/src/security.ts 的 hashPassword 保持同步（改动任何一边都必须同时改另一边）：
 *
 *   const salt = randomBytes(16).toString('hex');            // 32 个 hex 字符
 *   const key  = await deriveKey(password, salt);             // scrypt(password, salt, 64)
 *   return `${salt}:${key.toString('hex')}`;
 *
 * verifyPassword 按 ':' 切开，用同一个 salt 重算 64 字节并与存下的 hex 做 timingSafeEqual。
 * 所以这里必须同参数（keylen=64）同编码（salt 用 hex 字符串直接当 scrypt 的 salt 输入，
 * 不是 Buffer.from(hex,'hex')），否则哈希对不上，root 就登不进去。
 */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)),
  );
}

function countRows(db, tables) {
  const counts = new Map();
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    counts.set(table, Number(row?.n ?? 0));
  }
  return counts;
}

function printCounts(title, counts) {
  const width = Math.max(...[...counts.keys()].map(name => name.length));
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  console.log(`\n${title}`);
  for (const [table, count] of counts) {
    console.log(`  ${table.padEnd(width)}  ${String(count).padStart(6)}`);
  }
  console.log(`  ${'合计'.padEnd(width)}  ${String(total).padStart(6)}`);
}

/** 找出「不在 uploads 表里」的上传文件（只按已知扩展名筛，避免误删目录里的其它东西）。 */
function orphanUploadFiles(uploadsDir, knownIds) {
  if (!existsSync(uploadsDir)) return [];
  const entries = readdirSync(uploadsDir, { withFileTypes: true });
  const orphans = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) continue;
    const id = entry.name.slice(0, entry.name.length - extension.length);
    if (knownIds.has(id)) continue;
    orphans.push({ name: entry.name, path: join(uploadsDir, entry.name) });
  }
  return orphans.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveAdmin() {
  const uid = Number(process.env.ADMIN_UID ?? 1001);
  if (!Number.isInteger(uid) || uid < 1000 || uid > 9999) {
    fail(`ADMIN_UID 必须是 1000..9999 之间的整数：${process.env.ADMIN_UID}`);
  }
  const username = (process.env.ADMIN_USERNAME ?? 'root').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    fail(`ADMIN_USERNAME 必须是 3..32 位 [a-z0-9_]：${process.env.ADMIN_USERNAME}`);
  }
  const password = process.env.ADMIN_INITIAL_PASSWORD ?? '12345678';
  if (password.length < 8 || password.length > 128) {
    fail('ADMIN_INITIAL_PASSWORD 必须是 8..128 个字符');
  }
  return { uid, username, password };
}

/**
 * 初始普通用户（需求：新库首启就有 QJQ / 柒玖柒，让 DEFAULT_FRIEND_USERNAME 有真实账号可指）。
 * 与 resolveAdmin 同一套校验口径，uid 下限 10001（普通用户号段起点）。
 */
function resolveSeedUser() {
  const uid = Number(process.env.SEED_USER_UID ?? 10001);
  if (!Number.isInteger(uid) || uid < 10001 || uid > 999999) {
    fail(`SEED_USER_UID 必须是 10001..999999 之间的整数：${process.env.SEED_USER_UID}`);
  }
  const username = (process.env.SEED_USER_USERNAME ?? 'qjq').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    fail(`SEED_USER_USERNAME 必须是 3..32 位 [a-z0-9_]：${process.env.SEED_USER_USERNAME}`);
  }
  const displayName = (process.env.SEED_USER_DISPLAY_NAME ?? '柒玖柒').trim();
  if (displayName.length < 1 || displayName.length > 40) {
    fail('SEED_USER_DISPLAY_NAME 必须是 1..40 个字符');
  }
  const password = process.env.SEED_USER_INITIAL_PASSWORD ?? 'A454545asd@';
  if (password.length < 8 || password.length > 128) {
    fail('SEED_USER_INITIAL_PASSWORD 必须是 8..128 个字符');
  }
  return { uid, username, displayName, password };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`错误: ${error.message}\n`);
      console.error(USAGE);
      process.exit(1);
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }
  // 没有 --confirm 就不做任何写入，只提示用法。--dry-run 也必须带 --confirm，
  // 这样「看起来在预览、其实漏了 --confirm」不会被误读成「已经清过了」。
  if (!options.confirm) {
    console.error('拒绝执行：必须显式带 --confirm 参数才会清空数据库。\n');
    console.error(USAGE);
    process.exit(1);
  }

  let admin;
  let seedUser;
  try {
    admin = resolveAdmin();
    seedUser = resolveSeedUser();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`错误: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // --database 与 DATABASE_PATH 都允许相对路径，但一律相对 backend/ 解析（不是 cwd）：
  // .env 里的 DATABASE_PATH 按惯例写 `.data/chat.sqlite`，从仓库根目录执行脚本时
  // 若按 cwd 解析就会指到 /b/AITrance/.data/ 这个并不存在的位置。
  const rawDatabase = options.database ?? process.env.DATABASE_PATH ?? null;
  const databasePath = rawDatabase ? resolve(backendDir, rawDatabase) : resolve(backendDir, '.data', 'chat.sqlite');
  const uploadsDir = options.uploadsDir
    ? resolve(backendDir, options.uploadsDir)
    : resolve(dirname(databasePath), 'uploads');

  console.log(`数据库:   ${databasePath}`);
  console.log(`上传目录: ${options.cleanUploads ? uploadsDir : `${uploadsDir}（不清理）`}`);
  console.log(`模式:     ${options.dryRun ? 'dry-run（只预览，不写库）' : '执行'}`);

  if (!existsSync(databasePath)) {
    console.error(`\n错误: 数据库不存在: ${databasePath}\n（先启动一次服务端让它建库，或显式传 --database）`);
    process.exit(1);
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const tables = tableNames(db);
    if (!tables.has('users')) {
      console.error('\n错误: 库里没有 users 表，这不像是本项目的数据库。');
      process.exit(1);
    }
    // 老库（user_version < 4）的 users 还没补 uid/role/status 列。这个脚本刻意不重复 src/db.ts
    // 的整套迁移逻辑（两处各写一份必然漂移），而是要求「先启动一次服务端完成迁移」再重置。
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(row => String(row.name)));
    const missing = ['id', 'uid', 'username', 'display_name', 'avatar_url', 'bio', 'password_hash', 'role', 'status', 'created_at']
      .filter(column => !userColumns.has(column));
    if (missing.length > 0) {
      console.error(`\n错误: users 表缺少列 ${missing.join(', ')}，` +
        '请先启动一次服务端（会执行 db.ts 的迁移）再运行本脚本。');
      process.exit(1);
    }

    const present = BUSINESS_TABLES.filter(table => tables.has(table));
    const absent = BUSINESS_TABLES.filter(table => !tables.has(table));
    const before = countRows(db, present);
    printCounts('清空前各表行数:', before);
    if (absent.length > 0) console.log(`  （库中不存在、跳过: ${absent.join(', ')}）`);

    // 清空之后 uploads 表是空的，所以磁盘上所有上传文件按定义都是孤儿。
    // dry-run 用同样的语义预览，避免「预览说删 3 个、执行删 300 个」。
    const fileIds = options.dryRun
      ? new Set(db.prepare('SELECT id FROM uploads').all().map(row => String(row.id)))
      : new Set();
    const orphans = options.cleanUploads ? orphanUploadFiles(uploadsDir, fileIds) : [];

    if (options.dryRun) {
      console.log('\n[dry-run] 将执行:');
      for (const table of present) console.log(`  DELETE FROM ${table}`);
      if (tables.has('sqlite_sequence')) console.log('  DELETE FROM sqlite_sequence');
      console.log(`  INSERT INTO users 管理员 uid=${admin.uid} username=${admin.username} role=admin`);
      console.log(`  INSERT INTO users 初始普通用户 uid=${seedUser.uid} username=${seedUser.username}` +
        ` display_name=${seedUser.displayName} role=user`);
      console.log(`  PRAGMA foreign_key_check + PRAGMA wal_checkpoint(TRUNCATE)`);
      if (options.cleanUploads) console.log(`  删除孤儿上传文件 ${orphans.length} 个（${uploadsDir}）`);
      for (const orphan of orphans.slice(0, 20)) console.log(`    - ${orphan.name}`);
      if (orphans.length > 20) console.log(`    …以及另外 ${orphans.length - 20} 个`);
      console.log('\n[dry-run] 未写入任何数据。去掉 --dry-run 并保留 --confirm 才会真正执行。');
      return;
    }

    const passwordHash = hashPassword(admin.password);
    const seedPasswordHash = hashPassword(seedUser.password);
    const now = new Date().toISOString();

    // 迁移期间显式关外键：清空顺序虽然已经是子表在前，但外键关掉才能保证
    // 「某个未来新增的表还有指向 users 的外键」时脚本不会因为顺序变化而失败。
    // PRAGMA foreign_keys 在事务内设置无效，所以必须在 BEGIN 之前关、COMMIT 之后开。
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of present) db.exec(`DELETE FROM ${table}`);
      // sqlite_sequence 记录 AUTOINCREMENT 高水位；清掉它让 messages.id 从 1 重新开始。
      // 老库可能没有这张表（只有存在 AUTOINCREMENT 列时 SQLite 才建它）。
      if (tables.has('sqlite_sequence')) db.exec('DELETE FROM sqlite_sequence');
      db.prepare(
        `INSERT INTO users(id, uid, username, display_name, avatar_url, bio, password_hash, role, status, created_at)
         VALUES (?, ?, ?, ?, '', '', ?, 'admin', 'active', ?)`,
      ).run(randomUUID(), admin.uid, admin.username, '系统管理员', passwordHash, now);
      // 初始普通用户与管理员同时创建：两者都不存在时才建，清库后必然都不存在。
      // 这样 DEFAULT_FRIEND_USERNAME 指向的账号立刻可用，新用户注册时不会被 fail-closed 挡回 503。
      db.prepare(
        `INSERT INTO users(id, uid, username, display_name, avatar_url, bio, password_hash, role, status, created_at)
         VALUES (?, ?, ?, ?, '', '', ?, 'user', 'active', ?)`,
      ).run(randomUUID(), seedUser.uid, seedUser.username, seedUser.displayName, seedPasswordHash, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      console.error('\n外键校验失败（数据已提交，请人工检查）:');
      for (const violation of violations) console.error(' ', violation);
      process.exitCode = 1;
    }
    // 把 WAL 合并回主库并截断：重置后通常要立刻备份/拷走库文件，留着 WAL 容易只拷到半套数据。
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();

    const after = countRows(db, present);
    printCounts('清空后各表行数:', after);

    let removed = 0;
    let failedFiles = 0;
    for (const orphan of orphans) {
      try {
        unlinkSync(orphan.path);
        removed += 1;
      } catch (error) {
        failedFiles += 1;
        console.error(`  删除失败 ${orphan.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.cleanUploads) {
      console.log(`\n孤儿上传文件: 发现 ${orphans.length} 个，删除 ${removed} 个，失败 ${failedFiles} 个（${uploadsDir}）`);
    }

    const adminRow = db.prepare('SELECT uid, username, display_name, role, status, created_at FROM users ORDER BY uid');
    console.log('\n最终账号:');
    for (const row of adminRow.all()) {
      console.log(`  uid=${row.uid} username=${row.username} display_name=${row.display_name} ` +
        `role=${row.role} status=${row.status} created_at=${row.created_at}`);
    }
    console.log(`\n重置完成。用 ${admin.username} / ADMIN_INITIAL_PASSWORD（默认 12345678）登录管理员，` +
      `用 ${seedUser.username} / SEED_USER_INITIAL_PASSWORD（默认 A454545asd@）登录初始普通用户，并尽快改密码。`);
    if (violations.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
}
