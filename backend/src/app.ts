import { readFileSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { Type } from '@sinclair/typebox';
import { loadConfig, resolveRequireHttps, type Config } from './config.ts';
import { Store } from './db.ts';
import { ApiError, fail } from './errors.ts';
import { authenticate, digest, type Identity } from './security.ts';
import { Realtime } from './realtime.ts';
import { ChatService } from './service.ts';
import { registerRoutes } from './routes.ts';
import { ensureUploadsDir } from './upload.ts';
import { ensureAdmin } from './bootstrap.ts';

/**
 * SEC-04 安全响应头。
 * CSP 取值依据 docs/06-dev-setup.md §5.3（default-src 'self'; connect-src 'self' ws: wss:），
 * 并按前端实际产物校准：Vite 打包出外部 js/css（script-src/style-src 只需 'self'），
 * 头像为首字符+派生色渲染、无外链图片（img-src 加 data: 兜底），无外链字体（font-src 'self'），
 * WS 连接同源（connect-src 保留 ws:/wss: 以兼容 http/https 两种部署）。
 * 不使用 'unsafe-inline'/'unsafe-eval'：Vue 的 :style 绑定走 CSSOM，不受 style-src 限制。
 *
 * 注意：生产环境下 HTML 文档由 nginx 提供，后端 CSP 只作用于 API/JSON 响应，
 * 因此下面四个常量同时被 backend/deploy/nginx-chat.conf 与 nginx-chat-https.conf
 * 的文档级 add_header 逐字复制。改这里就必须同步改那两个 conf，
 * backend/test/deploy-headers.test.ts 会做逐字漂移检测并在不一致时失败。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: 是附件预览必需的：图片经 fetch(带 Bearer) 取回字节后要转成 blob: URL 才能塞进 <img>。
  // 直接指向 /api/v1/uploads/:id 不行（<img> 不会带 Authorization 头），所以只能走 blob:。
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
].join('; ');

/**
 * /docs（Swagger UI）自带的静态页会把 style 属性与运行时样式注入 DOM，
 * 与其上游 staticCSP 默认关闭的行为保持一致：只在文档路径放宽 style/script 的 inline，
 * 业务 API 仍然使用上面严格策略。
 */
export const DOCS_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
].join('; ');

export const PERMISSIONS_POLICY = [
  'accelerometer=()', 'camera=()', 'geolocation=()', 'gyroscope=()',
  'magnetometer=()', 'microphone=()', 'payment=()', 'usb=()',
].join(', ');

export const HSTS = 'max-age=31536000; includeSubDomains';

function readTlsMaterial(tls: NonNullable<Config['tls']>): { key: Buffer; cert: Buffer } {
  try {
    return { key: readFileSync(tls.keyPath), cert: readFileSync(tls.certPath) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TLS material is not readable (TLS_KEY_PATH/TLS_CERT_PATH): ${detail}`);
  }
}

/**
 * SEC-01 明文凭据判定规则（精确、可测）：
 * 只有「POST /api/v1/auth/register」与「POST /api/v1/auth/login」携带密码，
 * 因此只有这两条路径在 REQUIRE_HTTPS 生效时检查传输是否加密：
 *   1. 直连 TLS（本进程终结证书）→ socket.encrypted === true，视为安全；
 *   2. 反向代理终结 TLS → 仅当 TRUST_LOOPBACK_PROXY=true（Fastify trustProxy 限定 loopback）
 *      且 X-Forwarded-Proto 所有权重里最后一段为 https 时，视为安全；
 *   3. 其余情况（裸 http、代理头缺失、不可信来源伪造头）一律 403 HTTPS_REQUIRED。
 * REQUIRE_HTTPS 默认 auto：只有本进程启用 TLS 时才强制；由 nginx 终结 TLS 的部署
 * 必须在 chat.env 里显式写 REQUIRE_HTTPS=true（否则 proxy→backend 腿是明文）。
 */
const CREDENTIAL_PATHS = new Set(['/api/v1/auth/register', '/api/v1/auth/login']);

function isEncryptedTransport(request: FastifyRequest, trustLoopbackProxy: boolean): boolean {
  const socket = request.raw.socket as { encrypted?: boolean };
  if (socket.encrypted === true) return true;
  if (!trustLoopbackProxy) return false;
  const forwarded = request.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  if (typeof value !== 'string') return false;
  const last = value.split(',').at(-1)?.trim().toLowerCase();
  return last === 'https';
}

export async function buildApp(overrides: Partial<Config> = {}) {
  const loaded = loadConfig();
  const config = { ...loaded, ...overrides };
  // 覆盖项里改了 tls 时（测试/嵌入用法），用同一条 REQUIRE_HTTPS 规则重新推导，
  // 保证「进程自己终结 TLS ⇒ 默认要求 https」这一不变式不会被 Partial<Config> 绕过。
  if (overrides.tls !== undefined) {
    config.requireHttps = resolveRequireHttps(config.requireHttpsMode, config.tls);
  }
  if (config.tls !== null && (!config.tls.certPath || !config.tls.keyPath)) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be provided together');
  }
  const tls = config.tls === null ? null : readTlsMaterial(config.tls);
  const app = Fastify({
    ...(tls ? { https: tls } : {}),
    logger: config.logger === false ? false : {
      ...(typeof config.logger === 'object' ? config.logger : {}),
      redact: ['req.headers.authorization'],
      serializers: { req: request => ({ method: request.method, url: request.url?.split('?')[0], remoteAddress: request.ip }) },
    },
    bodyLimit: 32 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    requestTimeout: 30_000,
    trustProxy: config.trustLoopbackProxy ? 'loopback' : false,
  });
  const store = new Store(config.databasePath);
  // 目录必须在进程启动时就验证可写：否则第一次真实上传才会暴露配置错误，
  // 而那时代价是一条已经被用户等待的失败请求 + 一个 500。
  ensureUploadsDir(config.uploadsDir);
  const realtime = new Realtime(store, {
    sweepSeconds: config.retentionSweepSeconds,
    messageDays: config.retentionMessageDays,
    uploadsDir: config.uploadsDir,
    logger: app.log,
  });
  const service = new ChatService(store, realtime, config.uploadsDir);
  // 管理员引导必须在 registerRoutes 之前：路由里第一次登录就要能查到 1001，
  // 否则首启进程在「管理员还没建」的窗口里会把管理员登录当成 401。
  const bootstrap = await ensureAdmin(store, config);
  app.log.info({ admin: bootstrap.admin, uid: config.adminUid }, `admin bootstrap: ${bootstrap.admin}`);
  app.decorateRequest('identity', null);
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error instanceof ApiError ? error.statusCode : error.statusCode ?? 500;
    const code = error instanceof ApiError ? error.code
      : error.validation ? 'VALIDATION_ERROR'
      : statusCode === 429 ? 'RATE_LIMITED'
      // 上传接口的传输层错误发生在路由 handler 之前（fastify 在解析 body 阶段就拒绝），
      // 走不到业务层的 ApiError，只能在这里按状态码补齐契约里承诺的错误码，
      // 否则客户端拿到的是 BAD_REQUEST，无法区分「太大」「类型不支持」与其他 400。
      : statusCode === 413 ? 'UPLOAD_TOO_LARGE'
      : statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE'
      : statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
    if (statusCode >= 500) request.log.error({ error: { name: error.name, message: error.message } }, 'Request failed');
    reply.code(statusCode).send({ error: {
      code, message: statusCode >= 500 ? '服务暂时不可用' : error.message, traceId: request.id,
    } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在', traceId: request.id } }));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    const path = request.url.split('?')[0]!;
    // 只有真正渲染 Swagger UI 的 HTML 页面需要放宽 CSP；/openapi.json 是纯 JSON，
    // 浏览器不会把它当文档执行，因此保持严格策略（放宽范围要尽可能小）。
    const isDocumentation = path === '/docs' || path.startsWith('/docs/');
    reply.header('Content-Security-Policy', isDocumentation ? DOCS_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY);
    if (config.requireHttps) {
      reply.header('Strict-Transport-Security', HSTS);
      if (request.method === 'POST' && CREDENTIAL_PATHS.has(path)
        && !isEncryptedTransport(request, config.trustLoopbackProxy)) {
        fail(403, 'HTTPS_REQUIRED', '该接口必须通过 HTTPS 调用');
      }
    }
    const origin = request.headers.origin;
    if (origin && !config.origins.includes(origin)) fail(403, 'ORIGIN_FORBIDDEN', '不允许的请求来源');
  });
  await app.register(cors, { origin: config.origins, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'], credentials: false });
  app.addHook('onRequest', async request => {
    const path = request.url.split('?')[0]!;
    if (path.startsWith('/api/v1/') && !['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/health'].includes(path) && request.method !== 'OPTIONS') {
      request.identity = authenticate(store, request);
    }
  });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute',
    keyGenerator: request => request.identity?.userId ?? request.ip });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'WebChat API', version: '0.2.0', description: '网页聊天 MVP：账号、好友、私聊/群聊及实时消息。WebSocket 协议见 API.md。' },
      servers: [{ url: `http://localhost:${config.port}` }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: '注册或登录返回的 opaque token' } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.addHook('preClose', async () => realtime.close());
  app.addHook('onClose', async () => store.close());
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const healthSchema = { tags: ['System'], summary: '版本与协议健康检查', response: { 200: Type.Object({
    status: Type.Literal('ok'), version: Type.Literal('0.2.0'), protocolVersion: Type.Literal(1), serverTime: Type.String({ format: 'date-time' }),
  }) } };
  const health = async () => {
    store.get('SELECT 1');
    return { status: 'ok' as const, version: '0.2.0' as const, protocolVersion: 1 as const, serverTime: new Date().toISOString() };
  };
  app.get('/health', { schema: healthSchema }, health);
  app.get('/api/v1/health', { schema: healthSchema }, health);
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  registerRoutes(app, store, service, config);
  app.get<{ Querystring: { ticket?: string; v?: string } }>('/ws', {
    websocket: true,
    schema: { hide: true },
  }, (socket, request) => {
      if (request.query.v !== undefined && request.query.v !== '1') {
        socket.close(4002, 'Unsupported protocol version');
        return;
      }
      if (typeof request.query.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.query.ticket)) {
        socket.close(4001, 'Invalid ticket');
        return;
      }
      const ticketHash = digest(request.query.ticket);
      const session = store.transaction(() => {
        const row = store.get<Identity>(`SELECT session.user_id AS userId, session.token_hash AS sessionHash, session.expires_at AS expiresAt
          FROM ws_tickets ticket JOIN sessions session ON session.token_hash = ticket.session_hash
          WHERE ticket.ticket_hash = ? AND ticket.expires_at > ? AND session.expires_at > ?`,
        ticketHash, new Date().toISOString(), new Date().toISOString());
        store.run('DELETE FROM ws_tickets WHERE ticket_hash = ?', ticketHash);
        return row;
      });
      if (!session) {
        socket.close(4001, 'Invalid or expired ticket');
        return;
      }
      realtime.connect(socket, session);
  });
  try {
    await app.ready();
  } catch (error) {
    realtime.close();
    store.close();
    throw error;
  }
  // BE-01：启动即清理一次过期会话/票据，日志记录条数（重启后也能收敛）。
  realtime.sweep('startup');
  return { app, store, service, realtime, config, transport: tls ? 'https' as const : 'http' as const };
}
