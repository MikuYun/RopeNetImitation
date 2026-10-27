import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 当前 schema 版本，写在 SQLite 的 `PRAGMA user_version` 里。
 * 1 = 旧版（消息只有 text/system）；2 = 支持图片/文件附件（messages.attachment_id + uploads 表）；
 * 3 = 第二轮体验改造（users.uid/role/status/muted_until、群角色、群头像、消息置顶）。
 */
export const SCHEMA_VERSION = 3;

/**
 * 普通用户 uid 的起始值。管理员固定 1001（见 config.adminUid），
 * 普通用户从 10001 起递增，两段之间留出 1000..10000 的空白，
 * 未来要加「运营/客服」等特殊角色时可以直接占用空白段而不打乱既有 uid。
 */
const FIRST_USER_UID = 10001;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        -- v3：uid 是对外可展示、可登录的稳定数字 id；role/status 是管理后台的两根开关；
        -- muted_until 为 NULL 或过去时间表示未禁言（判定规则在 service 层，不写进 CHECK）。
        uid INTEGER,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'banned')),
        muted_until TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id),
        recipient_id TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK(sender_id <> recipient_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_friend_pair
        ON friend_requests(min(sender_id, recipient_id), max(sender_id, recipient_id)) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS requests_recipient ON friend_requests(recipient_id, status);
      CREATE TABLE IF NOT EXISTS friendships (
        user_id TEXT NOT NULL REFERENCES users(id), friend_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, PRIMARY KEY(user_id, friend_id), CHECK(user_id <> friend_id)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
        name TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
        -- v3：群头像。私聊恒为空串（对方的头像由前端按 peer.avatarUrl 决定）。
        avatar_url TEXT NOT NULL DEFAULT '',
        direct_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id), joined_at TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        -- v3：群内角色。owner 必须与 conversations.owner_id 指向同一人（迁移时回填、变更时同步）。
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
        PRIMARY KEY(conversation_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS members_user ON conversation_members(user_id, conversation_id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE,
        seq INTEGER NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        client_message_id TEXT NOT NULL,
        -- v0.2 起消息可携带附件：type 增加 image/file，attachment_id 指向 uploads。
        -- 新库直接把 attachment_id 写进建表语句；老库（user_version=1）由 migrate() 补列。
        type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'image', 'file')),
        content TEXT NOT NULL, attachment_id TEXT REFERENCES uploads(id), created_at TEXT NOT NULL,
        UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
      -- 附件元数据：文件字节在磁盘上，库里只存「谁传的、叫什么、多大、什么类型、sha256」。
      -- 单独建表而不是塞进 messages，是因为上传与发消息是两个独立动作（先上传拿到 id，再带着 id 发消息）。
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image', 'file')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner_id, created_at);
      -- v3：消息置顶。msg_id 是 messages.msg_id（对外 UUID），刻意不建外键：
      -- 消息被保留策略删除后，置顶记录由 sweep 之外的路径（读列表时 LEFT JOIN）自然失效，
      -- 加外键反而会让「删消息」必须先删置顶，把一条清理语句变成两处耦合。
      CREATE TABLE IF NOT EXISTS message_pins (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        msg_id TEXT NOT NULL,
        pinned_by TEXT NOT NULL REFERENCES users(id),
        pinned_at TEXT NOT NULL,
        UNIQUE(conversation_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS message_pins_conversation ON message_pins(conversation_id, pinned_at DESC);
      CREATE TABLE IF NOT EXISTS ws_tickets (
        ticket_hash TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
    `);
    // 建库语句只描述「最新结构」，且都是 IF NOT EXISTS，所以对已存在的库不产生任何写入。
    // 版本推进交给 migrate()：它读 sqlite_master 里的真实 DDL 判断老库是否需要重建，
    // 新建库（user_version=0）与老库（user_version=1/2）都会走到这里并落到 SCHEMA_VERSION，
    // 已升级的库则是纯 no-op —— 这就是「幂等迁移」的含义。
    this.migrate();
  }

  /**
   * 幂等迁移：把 user_version 1/2 的老库升到 3，不丢数据。
   *
   * 三件事：
   * 1. messages 要能存 image/file 且带上 attachment_id（v1→v2，已升级过的库自动跳过）；
   * 2. users/conversations/conversation_members 补 v3 的新列，并为既有用户回填 uid、为群主回填 role；
   * 3. 把 user_version 落到 SCHEMA_VERSION。
   *
   * 全部包在一个事务里：中途失败就整体回滚，不会留下「列加了但版本没升」的半套结构
   * （那种状态最危险：下次启动会因为列已存在而跳过，但数据没回填）。
   */
  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
    if (version >= SCHEMA_VERSION) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upgradeMessagesTable();
      this.upgradeUserColumns();
      this.upgradeConversationColumns();
      this.upgradeMemberColumns();
      // user_version 不支持参数绑定（PRAGMA 语法限制），这里的字面量来自代码常量而非外部输入。
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 只有当 messages 的建表语句里还没有 'image' 时才重建。
   * 判断依据直接取 sqlite_master 里的原始 SQL：比 PRAGMA table_info 更能反映 CHECK 约束，
   * 因为补列（ALTER TABLE ADD COLUMN）不会改变 CHECK，column 列表无法区分新旧结构。
   */
  private upgradeMessagesTable(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql?: string } | undefined;
    if (row === undefined || row.sql === undefined || row.sql.includes("'image'")) return;
    this.db.exec(`
      CREATE TABLE messages_upgrade (
        id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE,
        seq INTEGER NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        client_message_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'image', 'file')),
        content TEXT NOT NULL, attachment_id TEXT REFERENCES uploads(id), created_at TEXT NOT NULL,
        UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
      );
      INSERT INTO messages_upgrade(id, msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at, attachment_id)
        SELECT id, msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at, NULL FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_upgrade RENAME TO messages;
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
    `);
  }

  /** 读某张表真实存在的列名。用于「ADD COLUMN 前先判断列是否已存在」——重复加列会直接报错。 */
  private columnNames(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map(row => String(row.name)));
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (this.columnNames(table).has(column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * users 补 v3 列并回填 uid。
   *
   * uid 刻意用「ADD COLUMN 无约束 + 单独建唯一索引」：SQLite 的 ADD COLUMN 不允许 UNIQUE，
   * 而唯一性必须真的落到索引上才能防并发重号；索引对 NULL 不生效（部分索引 WHERE uid IS NOT NULL），
   * 正好容下「回填前的过渡态」。
   */
  private upgradeUserColumns(): void {
    this.addColumnIfMissing('users', 'uid', 'INTEGER');
    this.addColumnIfMissing('users', 'role', "TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'))");
    this.addColumnIfMissing('users', 'status', "TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'banned'))");
    this.addColumnIfMissing('users', 'muted_until', 'TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_uid ON users(uid) WHERE uid IS NOT NULL');
    // 回填既有用户的 uid：按注册时间升序，从 10001 起顺次编号。
    // 用 MAX(uid) 而不是「行数 + 10000」作为起点，是为了让「对象创建一半就被中断的库」也能收敛
    // （重复执行不会重号，只会从当前最大 uid 往后接）。
    const pending = this.db.prepare('SELECT id FROM users WHERE uid IS NULL ORDER BY created_at, id').all() as Array<{ id: string }>;
    if (pending.length === 0) return;
    const start = Number((this.db.prepare(
      'SELECT COALESCE(MAX(uid), 10000) + 1 AS next FROM users WHERE uid >= 10001',
    ).get() as { next: number }).next);
    const update = this.db.prepare('UPDATE users SET uid = ? WHERE id = ?');
    pending.forEach((row, index) => { update.run(Math.max(start, FIRST_USER_UID) + index, row.id); });
  }

  /** conversations 补群头像列。 */
  private upgradeConversationColumns(): void {
    this.addColumnIfMissing('conversations', 'avatar_url', "TEXT NOT NULL DEFAULT ''");
  }

  /**
   * conversation_members 补 role 并回填群主。
   *
   * 回填用「子查询对齐 owner_id」而不是「谁先创建谁就是 owner」：owner_id 是群主权威来源，
   * 这里只是把同一事实复制到成员行上；两者一旦不一致，权限判定就会出现「群主能做但成员列表显示 member」。
   */
  private upgradeMemberColumns(): void {
    this.addColumnIfMissing('conversation_members', 'role', "TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member'))");
    this.db.exec(`UPDATE conversation_members SET role = 'owner'
      WHERE user_id = (SELECT owner_id FROM conversations WHERE id = conversation_members.conversation_id)
        AND role <> 'owner'`);
  }

  get<Row>(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  all<Row>(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  transaction<Result>(operation: () => Result): Result {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
