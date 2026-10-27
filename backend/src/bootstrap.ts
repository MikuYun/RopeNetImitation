import { randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import { hashPassword } from './security.ts';

/** 启动引导需要的最小配置面。单独抽出来是为了让测试能只传这三项，不必伪造整个 Config。 */
export interface BootstrapOptions {
  adminUid: number;
  /** 管理员登录名（默认 root）。按 username COLLATE NOCASE 匹配，大小写不敏感。 */
  adminUsername: string;
  adminInitialPassword: string;
}

export interface BootstrapReport {
  /** created = 本次新建；exists = 库里已有该 uid 或 username，本次未新建。 */
  admin: 'created' | 'exists';
  /** exists 时真正命中的登录名（可能是历史上用 uid 当 username 的老库），便于启动日志说明。 */
  username: string;
}

interface AdminRow {
  id: string;
  uid: number | null;
  username: string;
  role: string;
}

/**
 * 找出「当前库里的管理员候选行」，最多两个、且互不重复：
 * 1. 先按 uid = adminUid 查（这是 v3 以来的权威锚点：1001 一定是管理员）；
 * 2. 再按 username = adminUsername COLLATE NOCASE 查（契约 §7：root 一定是管理员）。
 *
 * 为什么两个都要查而不是「命中一个就 return」：老库里管理员是 ensureAdmin 早期版本创建的
 * （username 曾经写成 String(adminUid)，即 '1001'）。如果只按 uid 命中就返回，
 * 一旦库里同时存在一个叫 root 的普通用户，那条路径就会被永久跳过 ——
 * 「root 一定是管理员」的不变式就悄悄失效了。两个候选都纠正一遍，代价只是一次 UPDATE。
 */
function adminCandidates(store: Store, options: BootstrapOptions): AdminRow[] {
  const columns = 'SELECT id, uid, username, role FROM users';
  const rows: AdminRow[] = [];
  const byUid = store.get<AdminRow>(`${columns} WHERE uid = ?`, options.adminUid);
  if (byUid) rows.push(byUid);
  const byName = store.get<AdminRow>(`${columns} WHERE username = ? COLLATE NOCASE`, options.adminUsername);
  if (byName && byName.id !== byUid?.id) rows.push(byName);
  return rows;
}

/**
 * 把一条命中的用户行纠正成管理员（幂等，只在真的不一致时才写）。
 *
 * role：无条件纠正为 admin —— 这正是「root 一定是管理员」的落地，也是契约 §7 的要求。
 *
 * uid：只在「adminUid 没有被别人占用」时对齐。若 adminUid 已被另一行占用（典型场景：
 * 按 username 命中的 root 是普通用户，而 1001 已经是老管理员），保持它自己的 uid 不动 ——
 * 去抢一个真实用户的对外编号会同时破坏两边的登录标识，比「uid 不是 1001」糟糕得多。
 * uid 为空（迁移中途异常库）时补成 adminUid：该值此刻必然空闲（按 uid 查没命中），
 * 而留空会让「用 #1001 登录」这条路直接失效。
 */
function reconcileAdminRow(store: Store, row: AdminRow, options: BootstrapOptions): void {
  const uidHolder = store.get<{ id: string }>('SELECT id FROM users WHERE uid = ?', options.adminUid);
  const uidTakenByOther = uidHolder !== undefined && uidHolder.id !== row.id;
  const nextUid = uidTakenByOther ? row.uid : options.adminUid;
  if (row.role === 'admin' && row.uid === nextUid) return;
  store.run('UPDATE users SET role = \'admin\', uid = ? WHERE id = ?', nextUid, row.id);
}

/**
 * 系统管理员初始化（契约 §三 / §7）。
 *
 * 幂等且「只写一次」：只要 uid=adminUid 或 username=adminUsername 已有对应用户，就不再新建 ——
 * 密码、昵称一律不动。每次重启都重置密码是灾难性的（运维改过的密码会被环境变量悄悄覆盖回去）。
 *
 * 唯一会写入的既有数据是 role/uid 的纠正（见 reconcileAdminRow）：它只做「删掉管理员标记」
 * 的反向操作不可能发生，因为把一个已存在的 root/1001 提升为管理员是契约的明确要求。
 */
export async function ensureAdmin(store: Store, options: BootstrapOptions): Promise<BootstrapReport> {
  const existing = adminCandidates(store, options);
  if (existing.length > 0) {
    store.transaction(() => {
      for (const row of adminCandidates(store, options)) reconcileAdminRow(store, row, options);
    });
    return { admin: 'exists', username: existing[0]!.username };
  }

  // 先算 scrypt（几百毫秒）再进事务：把 CPU 密集的密码派生塞进 BEGIN IMMEDIATE 会长时间占着写锁，
  // 拖慢同时启动的其它进程。事务内再做一次存在性复查，覆盖「两个进程同时首启」的竞态。
  const passwordHash = await hashPassword(options.adminInitialPassword);
  const created = store.transaction(() => {
    const races = adminCandidates(store, options);
    if (races.length > 0) {
      for (const row of races) reconcileAdminRow(store, row, options);
      return false;
    }
    const now = new Date().toISOString();
    store.run(`INSERT INTO users(id, uid, username, display_name, password_hash, role, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)`,
    randomUUID(), options.adminUid, options.adminUsername, '系统管理员', passwordHash, now);
    return true;
  });
  return { admin: created ? 'created' : 'exists', username: options.adminUsername };
}

/** 初始普通用户的引导配置面。与 BootstrapOptions 分开，便于测试只传需要的那几项。 */
export interface SeedUserOptions {
  uid: number;
  /** 登录名（默认 qjq），按 username COLLATE NOCASE 匹配，大小写不敏感。 */
  username: string;
  displayName: string;
  initialPassword: string;
}

export interface SeedUserReport {
  /** created = 本次新建；exists = 库里已有该 uid 或 username，本次未新建。 */
  seedUser: 'created' | 'exists';
  /** exists 时真正命中的登录名，便于启动日志说明。 */
  username: string;
}

interface SeedRow {
  id: string;
  uid: number | null;
  username: string;
  role: string;
}

/**
 * 找出「初始普通用户候选行」。
 *
 * 与 adminCandidates 的关键差别：管理员靠 uid 认人（1001 一定是管理员），
 * 预置普通用户靠 **username** 认人 —— 需求要的是「账号 QJQ 存在且新注册用户能加它为好友」，
 * 而默认好友是按 username 查的。如果 uid 被别的账号占了就当成「已存在」，
 * 会让 qjq 永远建不出来，DEFAULT_FRIEND_USERNAME 直接 fail-closed 503，整站注册全废。
 * 所以这里只按 username（大小写不敏感）匹配，uid 交给分配逻辑处理。
 */
function seedCandidates(store: Store, options: SeedUserOptions): SeedRow[] {
  const row = store.get<SeedRow>('SELECT id, uid, username, role FROM users WHERE username = ? COLLATE NOCASE',
    options.username);
  return row ? [row] : [];
}

/** 普通用户对外编号段：10001 起。被占用时往后找第一个空号，避免「按 uid 登录进错账号」。 */
function nextSeedUid(store: Store, preferred: number): number {
  const taken = store.get<{ id: string }>('SELECT id FROM users WHERE uid = ?', preferred);
  if (taken === undefined) return preferred;
  const max = store.get<{ value: number | null }>(
    'SELECT MAX(uid) AS value FROM users WHERE uid >= 10001')!;
  return Math.max(preferred, (max.value ?? preferred) + 1);
}

/**
 * 初始普通用户初始化（需求：新库首启就存在 QJQ / 柒玖柒，让 DEFAULT_FRIEND_USERNAME 有真实账号可指）。
 *
 * 幂等且「只写一次」：命中 uid 或 username 就不新建，密码、昵称、role 一律不动。
 * 唯一可能写入的是「uid 为空时补上 seedUserUid」——那是迁移中途异常库的兜底，
 * 且只在 seedUserUid 当前确实空闲时执行，不去抢别人的对外编号。
 */
export async function ensureSeedUser(store: Store, options: SeedUserOptions): Promise<SeedUserReport> {
  const existing = seedCandidates(store, options);
  if (existing.length > 0) {
    const row = existing[0]!;
    // 命中即「已存在」，密码/昵称/role 一律不动。唯一兜底：uid 为空时补号（迁移中途异常库）。
    if (row.uid === null) {
      store.transaction(() => {
        const again = seedCandidates(store, options)[0];
        if (again === undefined || again.uid !== null) return;
        store.run('UPDATE users SET uid = ? WHERE id = ?', nextSeedUid(store, options.uid), again.id);
      });
    }
    return { seedUser: 'exists', username: row.username };
  }

  // 与 ensureAdmin 同样：先算 scrypt 再进事务，避免长时间持有写锁；事务内二次复查覆盖并发首启。
  const passwordHash = await hashPassword(options.initialPassword);
  const created = store.transaction(() => {
    if (seedCandidates(store, options).length > 0) return false;
    const now = new Date().toISOString();
    store.run(`INSERT INTO users(id, uid, username, display_name, password_hash, role, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'user', 'active', ?)`,
    randomUUID(), nextSeedUid(store, options.uid), options.username, options.displayName, passwordHash, now);
    return true;
  });
  return { seedUser: created ? 'created' : 'exists', username: options.username };
}
