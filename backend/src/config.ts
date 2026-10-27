import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface TlsPaths {
  certPath: string;
  keyPath: string;
}

export type RequireHttpsMode = 'auto' | 'true' | 'false';

/**
 * REQUIRE_HTTPS 的唯一推导规则（注释即契约）：
 * - 'true'  → 一律要求 https（反向代理终结 TLS 但 proxy→backend 是明文的部署必须显式设置）；
 * - 'false' → 一律不要求（仅限明确自担风险的本地/内网部署）；
 * - 'auto'  → 只有当本进程自己终结 TLS（config.tls 非 null）时才要求。
 * buildApp 传入 tls 覆盖项时会用同一函数重新推导，避免「测试/嵌入用法绕过 auto」。
 */
export function resolveRequireHttps(mode: RequireHttpsMode, tls: TlsPaths | null): boolean {
  return mode === 'true' || (mode === 'auto' && tls !== null);
}

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  origins: string[];
  sessionTtlDays: number;
  trustLoopbackProxy: boolean;
  defaultFriendUsername: string;
  logger: boolean | { level: string };
  /** 启用 TLS 时非 null；此时 Fastify 直接以 https 监听（无反向代理终结 TLS）。 */
  tls: TlsPaths | null;
  /** 拒绝明文凭据请求（register/login 走 http 时 403 HTTPS_REQUIRED），见 app.ts onRequest 注释。 */
  requireHttps: boolean;
  /** requireHttps 的原始模式；buildApp 在 tls 被覆盖时用它重新推导 requireHttps。 */
  requireHttpsMode: RequireHttpsMode;
  /** 心跳/过期清理间隔（秒），同时驱动 sessions、ws_tickets 清理。 */
  retentionSweepSeconds: number;
  /** 消息保留天数；0 = 永不删除消息（默认）。 */
  retentionMessageDays: number;
  /**
   * 上传文件落盘目录（绝对路径）。
   * 默认与 DATABASE_PATH 同目录下的 `uploads/`：备份/迁移时数据与文件在同一次拷贝里，
   * 不容易出现「库迁走了文件没迁」的半套环境。
   */
  uploadsDir: string;
  /**
   * 系统管理员的固定 uid（1000..9999）。
   * 普通用户从 10001 起分配，两段不重叠，因此「1001 一定是管理员」这件事在数据层面就成立。
   */
  adminUid: number;
  /**
   * 系统管理员的登录名（小写、3..32 位 [a-z0-9_]），默认 `root`。
   * 与 adminUid 一起构成「root 一定是管理员」的稳定锚点：ensureAdmin 会先按 uid、
   * 再按 username COLLATE NOCASE 查找，任一命中都会把该行纠正成 admin+adminUid。
   */
  adminUsername: string;
  /**
   * 首次创建管理员时用的初始密码。只在「uid=adminUid 的用户不存在」时使用一次，
   * 之后重启一律不再读写它 —— 否则运维改过的密码会在每次重启时被这个环境变量覆盖回去。
   */
  adminInitialPassword: string;
  /**
   * 预置的「初始普通用户」。默认 QJQ / 柒玖柒。
   * 与 adminUid 同一套引导语义：只在库里不存在时创建，已存在则密码/昵称一律不动。
   * 为什么需要它：DEFAULT_FRIEND_USERNAME 指向的账号若不存在，注册接口会 fail-closed
   * 直接 503，新库首次部署就会出现「一个用户都注册不了」的死锁。
   * 置 SEED_USER_USERNAME='' 可整体关闭（测试与嵌入用法用得到）。
   */
  seedUser: SeedUserConfig | null;
}

export interface SeedUserConfig {
  uid: number;
  /** 登录名（小写、3..32 位 [a-z0-9_]）。 */
  username: string;
  /** 昵称，只在首次创建时写入。 */
  displayName: string;
  /** 初始密码，只在首次创建时使用一次。 */
  initialPassword: string;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw new Error(`Invalid integer configuration: ${value}`);
  }
  return result;
}

function nonNegativeInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > maximum) {
    throw new Error(`Invalid integer configuration: ${value}`);
  }
  return result;
}

/**
 * SEC-01：TLS 材料只从环境变量读取，且必须成对出现。
 * 返回 null 表示「不启用 TLS」（HTTP 模式，本地 dev 与 nginx 终结 TLS 的部署形态）。
 * 只要给了一个而缺另一个、或路径不可读、或不是普通文件，就直接抛错 —— 启动 fail-closed，
 * 绝不允许「配置了证书却静默退回明文」。
 */
export function loadTls(env: NodeJS.ProcessEnv = process.env): TlsPaths | null {
  const cert = env.TLS_CERT_PATH?.trim();
  const key = env.TLS_KEY_PATH?.trim();
  if (!cert && !key) return null;
  if (!cert || !key) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be provided together');
  }
  const pair: Array<[string, string]> = [['TLS_CERT_PATH', cert], ['TLS_KEY_PATH', key]];
  const paths: TlsPaths = { certPath: resolve(cert), keyPath: resolve(key) };
  for (const [name, value] of pair) {
    const path = resolve(value);
    try {
      if (!statSync(path).isFile()) throw new Error('not a regular file');
      accessSync(path, constants.R_OK);
    } catch {
      throw new Error(`${name} is not a readable file: ${value}`);
    }
  }
  return paths;
}

export function loadSeedUser(env: NodeJS.ProcessEnv = process.env): SeedUserConfig | null {
  const rawUsername = env.SEED_USER_USERNAME;
  // 显式置空 = 关闭预置账号。测试与嵌入用法靠它保持「库里只有管理员」的旧假设。
  if (rawUsername !== undefined && rawUsername.trim() === '') return null;
  const username = (rawUsername ?? 'qjq').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    throw new Error('SEED_USER_USERNAME must be empty or 3..32 characters of [a-z0-9_]');
  }
  const rawUid = env.SEED_USER_UID;
  const uid = rawUid === undefined ? 10001 : Number(rawUid);
  if (!Number.isInteger(uid) || uid < 10001 || uid > 999999) {
    throw new Error(`SEED_USER_UID must be an integer between 10001 and 999999: ${rawUid}`);
  }
  const rawDisplayName = env.SEED_USER_DISPLAY_NAME;
  const displayName = (rawDisplayName ?? '柒玖柒').trim();
  if (displayName.length < 1 || displayName.length > 40) {
    throw new Error('SEED_USER_DISPLAY_NAME must be 1..40 characters');
  }
  const initialPassword = env.SEED_USER_INITIAL_PASSWORD ?? 'A454545asd@';
  if (initialPassword.length < 8 || initialPassword.length > 128) {
    throw new Error('SEED_USER_INITIAL_PASSWORD must be 8..128 characters');
  }
  return { uid, username, displayName, initialPassword };
}

export function loadConfig(): Config {
  const defaultFriendUsername = (process.env.DEFAULT_FRIEND_USERNAME ?? '').trim().toLowerCase();
  if (defaultFriendUsername && !/^[a-z0-9_]{3,32}$/.test(defaultFriendUsername)) {
    throw new Error('DEFAULT_FRIEND_USERNAME must be empty or a valid username');
  }
  const trustLoopbackProxy = process.env.TRUST_LOOPBACK_PROXY ?? 'false';
  if (!['true', 'false'].includes(trustLoopbackProxy)) {
    throw new Error('TRUST_LOOPBACK_PROXY must be true or false');
  }
  const requireHttpsRaw = process.env.REQUIRE_HTTPS ?? 'auto';
  if (requireHttpsRaw !== 'auto' && requireHttpsRaw !== 'true' && requireHttpsRaw !== 'false') {
    throw new Error('REQUIRE_HTTPS must be auto, true or false');
  }
  const requireHttpsMode: RequireHttpsMode = requireHttpsRaw;
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(origin => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`CORS_ORIGINS must contain exact HTTP origins: ${origin}`);
    }
  }
  // ADMIN_UID 必须落在 1000..9999 这段「特殊角色保留区」里。
  // 普通用户从 10001 起分配，所以这里只要不越界，管理员 uid 就永远不会和普通用户撞号。
  const adminUid = positiveInteger(process.env.ADMIN_UID, 1001, 9999);
  if (adminUid < 1000) throw new Error(`ADMIN_UID must be between 1000 and 9999: ${adminUid}`);
  // 管理员的登录名，默认 root（契约 §7）。与普通用户同一套校验规则，
  // 保证「管理员只能用合法 username 登录」这件事在配置层就成立。
  const adminUsername = (process.env.ADMIN_USERNAME ?? 'root').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(adminUsername)) {
    throw new Error('ADMIN_USERNAME must be 3..32 characters of [a-z0-9_]');
  }
  // 初始密码只在首次创建管理员时用一次。默认值写在契约里（便于首次部署直接可用），
  // 但运维应当通过 ADMIN_INITIAL_PASSWORD 覆盖；长度下限 8 与注册接口保持一致。
  const adminInitialPassword = process.env.ADMIN_INITIAL_PASSWORD ?? '12345678';
  if (adminInitialPassword.length < 8 || adminInitialPassword.length > 128) {
    throw new Error('ADMIN_INITIAL_PASSWORD must be 8..128 characters');
  }
  // 预置的初始普通用户（默认 QJQ / 柒玖柒）。与 admin 同一套「只创建一次」语义，
  // 目的是让 DEFAULT_FRIEND_USERNAME 在新库首启时一定有个真实账号可指向。
  // 空串 = 整体关闭（测试/嵌入用法用它来保持「库里只有管理员」的旧假设）。
  const seedUser = loadSeedUser();
  const tls = loadTls();
  const databasePath = resolve(process.env.DATABASE_PATH ?? '.data/chat.sqlite');
  // UPLOADS_DIR 未配置时跟着库文件走：<数据库所在目录>/uploads。
  // 只有在 DATABASE_PATH 是 :memory: 时才需要显式指定（内存库没有「同目录」可言）；
  // 这种情况下用进程 cwd 下的 .data/uploads，保证测试/嵌入用法也能跑。
  const uploadsDir = resolve(
    process.env.UPLOADS_DIR ?? (databasePath === ':memory:' ? '.data/uploads' : resolve(databasePath, '..', 'uploads')),
  );
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: positiveInteger(process.env.PORT, 3001, 65535),
    databasePath,
    origins,
    sessionTtlDays: positiveInteger(process.env.SESSION_TTL_DAYS, 7, 30),
    trustLoopbackProxy: trustLoopbackProxy === 'true',
    defaultFriendUsername,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    tls,
    // REQUIRE_HTTPS=auto（默认）：仅当本进程自己终结 TLS 时强制 https；
    // 反向代理终结 TLS 的部署请显式 REQUIRE_HTTPS=true，否则 proxy→backend 段是明文。
    requireHttps: resolveRequireHttps(requireHttpsMode, tls),
    requireHttpsMode,
    retentionSweepSeconds: positiveInteger(process.env.RETENTION_SWEEP_SECONDS, 30, 3600),
    retentionMessageDays: nonNegativeInteger(process.env.RETENTION_MESSAGE_DAYS, 0, 3650),
    uploadsDir,
    adminUid,
    adminUsername,
    adminInitialPassword,
    seedUser,
  };
}
