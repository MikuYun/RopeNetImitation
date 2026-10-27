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
