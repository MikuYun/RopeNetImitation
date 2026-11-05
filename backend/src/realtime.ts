import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Identity } from './security.ts';
import type { Store } from './db.ts';
import { removeUploadFile } from './upload.ts';

interface Client {
  socket: WebSocket;
  identity: Identity;
  alive: boolean;
  windowStart: number;
  eventCount: number;
}

export interface RealtimeOptions {
  /** 心跳与过期清理的间隔（秒）。默认 30。 */
  sweepSeconds?: number;
  /** 消息保留天数；0 表示不删除消息（默认）。 */
  messageDays?: number;
  /** 上传文件落盘目录；给定时 sweep 才会连带清理孤儿上传。 */
  uploadsDir?: string;
  /** 清理计数日志出口；测试可传 false 静音。 */
  logger?: { info: (object: Record<string, unknown>, message: string) => void } | false;
}

export interface SweepReport {
  sessions: number;
  tickets: number;
  messages: number;
  uploads: number;
}

const HEARTBEAT_SECONDS = 30;

/** sessions/ws_tickets 的过期判定与 messages 的年龄判定都基于 UTC ISO 字符串，可直接字典序比较。 */
export class Realtime {
  private clients = new Map<string, Set<Client>>();
  private timer: NodeJS.Timeout;
  private store: Store;
  private readonly messageDays: number;
  private readonly uploadsDir: string | undefined;
  private readonly logger: RealtimeOptions['logger'];

  constructor(store: Store, options: RealtimeOptions = {}) {
    this.store = store;
    this.messageDays = options.messageDays ?? 0;
    this.uploadsDir = options.uploadsDir;
    this.logger = options.logger ?? false;
    const interval = Math.max(1, Math.min(options.sweepSeconds ?? HEARTBEAT_SECONDS, 3600));
    this.timer = setInterval(() => this.heartbeat(), interval * 1000);
    this.timer.unref();
  }

  isOnline(userId: string): boolean {
    return (this.clients.get(userId)?.size ?? 0) > 0;
  }

  /**
   * 当前在线的用户数（管理后台统计用）。
   * 只数「有活跃连接的用户」而不是连接数：同一个人开两个标签页仍然只算 1 人在线。
   */
  onlineCount(): number {
    return this.clients.size;
  }

  publish(userIds: string[], type: string, data: unknown): void {
    const event = JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: new Date().toISOString(), data });
    for (const userId of new Set(userIds)) {
      for (const client of this.clients.get(userId) ?? []) {
        if (this.sessionValid(client)) this.send(client.socket, event);
        else client.socket.close(4003, 'Session expired');
      }
    }
  }

  /**
   * 广播给所有在线用户（v2 广场事件）。
   *
   * 广场帖子没有「成员名单」，点赞/评论/删帖要通知的是全体在线用户，
   * 因此这里没有收件人过滤 —— 与 publish 共用同一份序列化结果，
   * 保证同一条事件在所有人那里 id/timestamp 完全一致（前端可据此去重）。
   *
   * 注意：在线用户数可能很大，Action 里不要放完整 Post（含作者 User 与附件），
   * 只放 {postId, actorId}，客户端收到后自行决定是否重拉列表。
   */
  broadcastAll(type: string, data: unknown): void {
    const event = JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: new Date().toISOString(), data });
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (this.sessionValid(client)) this.send(client.socket, event);
        else client.socket.close(4003, 'Session expired');
      }
    }
  }

  private send(socket: WebSocket, event: string): void {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, 'Slow consumer; reconnect and synchronize');
      return;
    }
    socket.send(event);
  }

  private presence(userId: string, online: boolean): void {
    const peers = this.store.all<{ user_id: string }>(`
      SELECT friend_id AS user_id FROM friendships WHERE user_id = ?
      UNION SELECT peer.user_id FROM conversation_members mine
      JOIN conversation_members peer ON mine.conversation_id = peer.conversation_id
      WHERE mine.user_id = ? AND peer.user_id <> ?`, userId, userId, userId);
    this.publish(peers.map(peer => peer.user_id), 'presence.changed', { userId, online });
  }

  connect(socket: WebSocket, identity: Identity): void {
    const clients = this.clients.get(identity.userId) ?? new Set<Client>();
    if (clients.size >= 5) {
      socket.close(1008, 'Too many connections');
      return;
    }
    const wasOnline = clients.size > 0;
    const client: Client = { socket, identity, alive: true, windowStart: Date.now(), eventCount: 0 };
    clients.add(client);
    this.clients.set(identity.userId, clients);
    socket.on('pong', () => { client.alive = true; });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clients.delete(client);
      if (clients.size === 0) {
        this.clients.delete(identity.userId);
        this.presence(identity.userId, false);
      }
    });
    socket.on('message', (buffer, isBinary) => {
      if (!this.sessionValid(client)) {
        socket.close(4003, 'Session expired');
        return;
      }
      if (Date.now() - client.windowStart > 10_000) {
        client.windowStart = Date.now();
        client.eventCount = 0;
      }
      client.eventCount++;
      if (client.eventCount > 30) {
        socket.close(1008, 'Too many events');
        return;
      }
      if (isBinary) {
        socket.close(1003, 'Binary events are unsupported');
        return;
      }
      try {
        const event: unknown = JSON.parse(buffer.toString());
        if (!event || typeof event !== 'object') throw new Error('Invalid event');
        const payload = event as Record<string, unknown>;
        if (payload.v !== 1) {
          socket.close(4002, 'Unsupported protocol version');
          return;
        }
        if (payload.type === 'ping') {
          this.send(socket, JSON.stringify({ v: 1, id: randomUUID(), type: 'pong', timestamp: new Date().toISOString(), data: {} }));
          return;
        }
        if (payload.type !== 'typing' || typeof payload.conversationId !== 'string' || typeof payload.active !== 'boolean') {
          throw new Error('Use ping or typing');
        }
        const member = this.store.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
          payload.conversationId, identity.userId);
        if (!member) throw new Error('Conversation unavailable');
        const members = this.store.all<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id = ?', payload.conversationId);
        this.publish(members.map(member => member.user_id).filter(userId => userId !== identity.userId), 'typing.changed', {
          conversationId: payload.conversationId, userId: identity.userId, active: payload.active,
        });
      } catch {
        this.send(socket, JSON.stringify({ v: 1, id: randomUUID(), type: 'error', timestamp: new Date().toISOString(),
          data: { code: 'INVALID_EVENT', message: '事件无效或无权访问该会话' } }));
      }
    });
    const serverTime = new Date().toISOString();
    this.send(socket, JSON.stringify({ v: 1, id: randomUUID(), type: 'ready', timestamp: serverTime,
      data: { userId: identity.userId, serverTime, protocolVersion: 2 } }));
    if (!wasOnline) this.presence(identity.userId, true);
  }

  private sessionValid(client: Client): boolean {
    return Boolean(this.store.get('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?',
      client.identity.sessionHash, new Date().toISOString()));
  }

  revoke(sessionHash: string): void {
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (client.identity.sessionHash === sessionHash) client.socket.close(4003, 'Session revoked');
      }
    }
  }

  /**
   * BE-01 保留策略：显式、可配置、可观测。
   * - sessions / ws_tickets：过期即删（保留语义不变，仅从心跳里抽出为独立可调用方法）。
   * - messages：仅当 RETENTION_MESSAGE_DAYS > 0 时按 created_at 删除，默认 0 = 永不删除。
   * - uploads：与 messages 用同一条保留期。只清「没有任何消息/帖子/表情包引用」且已过期的上传，
   *   被消息引用的上传归消息生命周期管（消息删了才会变成孤儿，下一轮再清）。
   *   v5 起表情包也算引用：用户收藏的表情包不该因为「没发过消息」就被保留策略清掉。
   * - 每次清理返回条数并由调用方写日志；服务启动时会先跑一次（app.ts），因此重启后也能收敛。
   */
  sweep(trigger: 'startup' | 'interval' | 'manual' = 'manual'): SweepReport {
    const now = new Date().toISOString();
    // 顺序有语义：ws_tickets.session_hash 引用 sessions(token_hash) 且 ON DELETE CASCADE，
    // 若先删 sessions，过期会话对应的 ticket 会被级联带走，随后删 tickets 的 changes 恒为 0，
    // 清理条数就不可观测了。先删 tickets 再删 sessions，两个计数都真实。
    const tickets = Number(this.store.run('DELETE FROM ws_tickets WHERE expires_at <= ?', now).changes);
    const sessions = Number(this.store.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes);
    let messages = 0;
    let uploads = 0;
    if (this.messageDays > 0) {
      const cutoff = new Date(Date.now() - this.messageDays * 86_400_000).toISOString();
      // v2：消息与附件是 message_attachments 多对多，删消息时该表的行随外键级联消失，
      // 因此这里的孤儿判定改为「没有被任何 message_attachments 行引用」。
      messages = Number(this.store.run('DELETE FROM messages WHERE created_at <= ?', cutoff).changes);
      // 先查后删：删完就拿不到 mime_type 了，而磁盘文件名需要它推导扩展名。
      // NOT EXISTS 而不是 NOT IN：子查询若有 NULL 会污染整个结果集。
      const orphans = this.store.all<{ id: string; mime_type: string }>(`SELECT id, mime_type FROM uploads
        WHERE created_at <= ? AND NOT EXISTS (
          SELECT 1 FROM message_attachments WHERE message_attachments.attachment_id = uploads.id)
        AND NOT EXISTS (
          SELECT 1 FROM post_attachments WHERE post_attachments.attachment_id = uploads.id)
        AND NOT EXISTS (
          SELECT 1 FROM stickers WHERE stickers.upload_id = uploads.id)`, cutoff);
      for (const orphan of orphans) {
        // 先删库再删文件：进程在两步之间崩溃时只会剩一个孤儿文件，下一轮 sweep 会再试；
        // 反过来（先删文件）则会留下「库里有记录、文件已没了」的坏记录，GET 只会 404，更糟。
        this.store.run('DELETE FROM uploads WHERE id = ?', orphan.id);
        if (this.uploadsDir) removeUploadFile(this.uploadsDir, orphan.id, orphan.mime_type);
      }
      uploads = orphans.length;
    }
    const report = { sessions, tickets, messages, uploads };
    if (this.logger && (sessions + tickets + messages + uploads > 0 || trigger === 'startup')) {
      this.logger.info({ retention: report, trigger, messageDays: this.messageDays }, 'Retention sweep completed');
    }
    return report;
  }

  private heartbeat(): void {
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (!this.sessionValid(client)) {
          client.socket.close(4003, 'Session expired');
        } else if (!client.alive) {
          client.socket.terminate();
        } else {
          client.alive = false;
          client.socket.ping();
        }
      }
    }
    this.sweep('interval');
  }

  close(): void {
    clearInterval(this.timer);
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        client.socket.removeAllListeners('close');
        client.socket.terminate();
      }
    }
    this.clients.clear();
  }
}
