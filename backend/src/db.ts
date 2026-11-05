import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 当前 schema 版本，写在 SQLite 的 `PRAGMA user_version` 里。
 * 1 = 旧版（消息只有 text/system）；2 = 支持图片/文件附件（messages.attachment_id + uploads 表）；
 * 3 = 第二轮体验改造（users.uid/role/status/muted_until、群角色、群头像、消息置顶）；
 * 4 = v2 契约：多项附件（message_attachments）、消息撤回/回复（recalled_at/reply_to_msg_id）、
 *     视频消息（uploads.kind 增加 video、messages.type 增加 video/mixed）、广场（posts 系列表）；
 * 5 = 个人表情包（stickers 表：owner 复用既有 upload，可重复发送）。
 */
export const SCHEMA_VERSION = 5;

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
        -- v4：一条消息可携带最多 9 个附件，具体关联落在 message_attachments，
        -- 因此 messages 表不再有 attachment_id 列；type 由服务端按附件构成推导
        -- （无附件 text / 只图 image / 只视频 video / 只文件 file / 混合 mixed）。
        type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'image', 'video', 'file', 'mixed')),
        content TEXT NOT NULL,
        -- v4：撤回时间（NULL = 未撤回）与回复目标。reply_to_msg_id 用 ON DELETE SET NULL：
        -- 被回复的消息被保留策略删掉后，回复关系自然降级为 NULL，而不是把这条回复一起删掉。
        recalled_at TEXT,
        reply_to_msg_id TEXT REFERENCES messages(msg_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
      -- 附件元数据：文件字节在磁盘上，库里只存「谁传的、叫什么、多大、什么类型、sha256」。
      -- 单独建表而不是塞进 messages，是因为上传与发消息是两个独立动作（先上传拿到 id，再带着 id 发消息）。
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'file')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner_id, created_at);
      -- v4：消息与附件的多对多关联。position 保留客户端排序（0 起）。
      -- attachment 侧索引用于两个高频反查：「这个附件是否已被引用」（上传后发消息去重/鉴权）与
      -- GET /uploads/:id 的读取权限判定（附件是否被某条消息引用）。
      CREATE TABLE IF NOT EXISTS message_attachments (
        msg_id TEXT NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES uploads(id),
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(msg_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS message_attachments_attachment ON message_attachments(attachment_id);
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
      -- v4：广场（动态流）。status 只有 active/deleted 两种，删除是软删除：
      -- 计数（like_count/comment_count）在删除时递减，历史评论/点赞行保留以便审计与恢复。
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
        like_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS posts_feed ON posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS posts_author ON posts(author_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS post_attachments (
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES uploads(id),
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(post_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS post_attachments_attachment ON post_attachments(attachment_id);
      CREATE TABLE IF NOT EXISTS post_likes (
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(post_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS post_comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        -- 楼中楼：被回复的评论被删（物理删除）时退化为普通评论，而不是连带删除这一条。
        reply_to_id TEXT REFERENCES post_comments(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS post_comments_feed ON post_comments(post_id, created_at);
      -- v5：个人表情包。表情包不复制文件字节，而是「把自己已有的 upload 收藏成一条可复用的快捷方式」，
      -- 因此 upload_id 指向 uploads：同一张图只有一份字节、一份元数据，消息里反复引用同一附件 id。
      -- UNIQUE(owner_id, upload_id) 让重复收藏变成幂等（服务层据此返回 200 而不是 201）。
      CREATE TABLE IF NOT EXISTS stickers (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(owner_id, upload_id)
      );
      CREATE INDEX IF NOT EXISTS stickers_owner ON stickers(owner_id, created_at);
      -- upload 侧索引：上传删除前的「是否被表情包引用」检查与保留策略的孤儿判定都要反查它。
      CREATE INDEX IF NOT EXISTS stickers_upload ON stickers(upload_id);
    `);
    // 建库语句只描述「最新结构」，且都是 IF NOT EXISTS，所以对已存在的库不产生任何写入。
    // 版本推进交给 migrate()：它读 sqlite_master 里的真实 DDL 判断老库是否需要重建，
    // 新建库（user_version=0）与老库（user_version=1/2/3/4）都会走到这里并落到 SCHEMA_VERSION，
    // 已升级的库则是纯 no-op —— 这就是「幂等迁移」的含义。
    // v5 只是新增 stickers 表（上面无条件执行的 CREATE TABLE IF NOT EXISTS 就已经建好了），
    // 不需要任何数据搬迁；把 user_version 抬到 5 是为了让版本号与真实结构一致。
    this.migrate();
  }

  /**
   * 幂等迁移：把 user_version 1/2/3/4 的老库升到 5，不丢数据。
   *
   * 四件事：
   * 1. messages 重建到 v4 形态（多附件 / 撤回 / 回复 / type 增加 video+mixed），
   *    并把老的 attachment_id 数据搬进 message_attachments（position=0）；
   * 2. uploads.kind 的 CHECK 从 image|file 扩到 image|video|file（SQLite 改不了 CHECK，只能重建表）；
   * 3. users/conversations/conversation_members 补 v3 的新列，并为既有用户回填 uid、为群主回填 role；
   * 4. 把 user_version 落到 SCHEMA_VERSION（v5 仅新增 stickers 表，已由构造函数建好，无数据搬迁）。
   *
   * 全部包在一个事务里：中途失败就整体回滚，不会留下「列加了但版本没升」的半套结构
   * （那种状态最危险：下次启动会因为列已存在而跳过，但数据没回填）。
   *
   * 迁移期间显式关闭外键（SQLite 官方对「重建表」的标准做法）：`DROP TABLE` 在开启外键时
   * 会执行一次隐式 DELETE，配合 message_attachments 上的 ON DELETE CASCADE 可能把刚搬过去的
   * 关联行级联删掉；同时 uploads 重建时 messages.attachment_id 的旧外键也会阻塞 DROP。
   * PRAGMA foreign_keys 在事务内设置是 no-op，所以必须在 BEGIN 之前关、COMMIT 之后开。
   */
  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
    if (version >= SCHEMA_VERSION) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upgradeMessagesTable();
      this.upgradeUploadsKind();
      this.upgradeUserColumns();
      this.upgradeConversationColumns();
      this.upgradeMemberColumns();
      // user_version 不支持参数绑定（PRAGMA 语法限制），这里的字面量来自代码常量而非外部输入。
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      // 无论成功失败都要把外键打开：迁移失败后进程会抛错退出，但这个 Store 在测试里可能被复用。
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /** messages 表当前的真实建表 SQL（不存在时返回 undefined）。 */
  private tableSql(table: string): string | undefined {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
    return row?.sql;
  }

  /**
   * 把 messages 重建到 v4 形态。
   *
   * 幂等判据取「建表 SQL 里有没有 recalled_at」：v1（无附件列）、v2/v3（有 attachment_id）
   * 都没有这一列，新库与已升级库都有，所以一次判断同时覆盖三条历史路径。
   * 不用 PRAGMA table_info 判断，是因为补列（ALTER TABLE ADD COLUMN）不改变 CHECK 约束，
   * 列名集合无法区分 v1 与 v3 的 type CHECK。
   *
   * 旧 attachment_id 的数据必须「先搬出去再 DROP」：v1 没有这一列，只重建结构即可。
   * 只搬「uploads 里确实存在的」关联，历史上被手工清过库的悬空 attachment_id 直接丢弃
   * （否则会在 message_attachments 上留下永远无法 JOIN 到的外键孤儿）。
   */
  private upgradeMessagesTable(): void {
    const sql = this.tableSql('messages');
    if (sql === undefined || sql.includes('recalled_at')) return;
    if (this.columnNames('messages').has('attachment_id')) {
      this.db.exec(`
        INSERT INTO message_attachments(msg_id, attachment_id, position)
          SELECT messages.msg_id, messages.attachment_id, 0 FROM messages
          JOIN uploads ON uploads.id = messages.attachment_id
          WHERE messages.attachment_id IS NOT NULL;
      `);
    }
    this.db.exec(`
      CREATE TABLE messages_upgrade (
        id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE,
        seq INTEGER NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        client_message_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'image', 'video', 'file', 'mixed')),
        content TEXT NOT NULL,
        recalled_at TEXT,
        reply_to_msg_id TEXT REFERENCES messages(msg_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
      );
      INSERT INTO messages_upgrade(id, msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at, recalled_at, reply_to_msg_id)
        SELECT id, msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at, NULL, NULL FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_upgrade RENAME TO messages;
      -- 索引必须跟着重建：DROP TABLE 会把挂在旧表上的索引一起删掉。
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
    `);
    // 搬迁过来的附件消息：type 跟随 uploads.kind 修正（老库只写过 image/file，
    // 但 uploads.kind 在 v4 之后可能是 video，这里一并映射，避免消息说 image 实际是视频）。
    this.db.exec(`
      UPDATE messages SET type = (
        SELECT CASE uploads.kind WHEN 'image' THEN 'image' WHEN 'video' THEN 'video' ELSE 'file' END
        FROM message_attachments JOIN uploads ON uploads.id = message_attachments.attachment_id
        WHERE message_attachments.msg_id = messages.msg_id
        ORDER BY message_attachments.position LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM message_attachments WHERE message_attachments.msg_id = messages.msg_id)
        AND type NOT IN ('system', 'mixed');
    `);
  }

  /**
   * uploads.kind 增加 video。SQLite 无法修改已存在的 CHECK 约束，只能重建表。
   * 幂等判据：建表 SQL 里是否已经包含 'video'（新库由建库语句直接带上，老库没有）。
   */
  private upgradeUploadsKind(): void {
    const sql = this.tableSql('uploads');
    if (sql === undefined || sql.includes("'video'")) return;
    this.db.exec(`
      CREATE TABLE uploads_upgrade (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'file')),
        created_at TEXT NOT NULL
      );
      INSERT INTO uploads_upgrade(id, owner_id, name, mime_type, size, sha256, kind, created_at)
        SELECT id, owner_id, name, mime_type, size, sha256, kind, created_at FROM uploads;
      DROP TABLE uploads;
      ALTER TABLE uploads_upgrade RENAME TO uploads;
      CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner_id, created_at);
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
