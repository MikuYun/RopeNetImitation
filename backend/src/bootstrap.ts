import { randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import { hashPassword } from './security.ts';

/** 启动引导需要的最小配置面。单独抽出来是为了让测试能只传这两项，不必伪造整个 Config。 */
export interface BootstrapOptions {
  adminUid: number;
  adminInitialPassword: string;
}

export interface BootstrapReport {
  /** created = 本次新建；exists = 库里已有该 uid，本次未做任何写入。 */
  admin: 'created' | 'exists';
}

/**
 * 系统管理员初始化（契约 §三）。
 *
 * 幂等且「只写一次」：只要 uid=adminUid 已存在就完全不动它 —— 包括密码、昵称、role。
 * 每次重启都重置密码是灾难性的（运维改过的密码会被环境变量悄悄覆盖回去），
 * 而把已有普通用户「提升」成管理员则更糟（等于给一个已知账号后台权限）。
 */
export async function ensureAdmin(store: Store, options: BootstrapOptions): Promise<BootstrapReport> {
  const existing = store.get<{ id: string }>('SELECT id FROM users WHERE uid = ?', options.adminUid);
  if (existing) return { admin: 'exists' };

  // 先算 scrypt（几百毫秒）再进事务：把 CPU 密集的密码派生塞进 BEGIN IMMEDIATE 会长时间占着写锁，
  // 拖慢同时启动的其它进程。事务内再做一次存在性复查，覆盖「两个进程同时首启」的竞态。
  const passwordHash = await hashPassword(options.adminInitialPassword);
  const created = store.transaction(() => {
    if (store.get('SELECT 1 FROM users WHERE uid = ?', options.adminUid)) return false;
    const now = new Date().toISOString();
    store.run(`INSERT INTO users(id, uid, username, display_name, password_hash, role, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)`,
    randomUUID(), options.adminUid, String(options.adminUid), '系统管理员', passwordHash, now);
    return true;
  });
  return { admin: created ? 'created' : 'exists' };
}
