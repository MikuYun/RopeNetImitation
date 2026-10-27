#!/usr/bin/env node
/**
 * OPS-02 容量/负载演练（隔离实例，本机临时库）
 *
 * 做什么：
 *   1. 用真实服务代码 buildApp() 起一个本地实例（127.0.0.1 随机端口，SQLite 在系统临时目录）；
 *   2. 直接 seed N 个用户 + N 个 session + 1 个 N 人群聊（绕过注册/登录限流，见 README 说明），
 *      然后用真实 REST 端点建立 M 条 WebSocket 连接（每条连接用自己的 ticket）；
 *   3. 持续 DURATION 秒，以 RATE msg/s 通过 REST POST 发消息（发送者在用户间轮转）；
 *   4. 同时用独立探测用户周期性打 GET /health、GET /api/v1/auth/session，记录 REST 延迟；
 *   5. 收集每个 WS 客户端的到达延迟、seq 缺失/重复，统计 p50/p95/p99/max；
 *   6. 复测两个边界：单用户第 6 条 WS 连接是否 close 1008；单用户高频发消息是否 429 + Retry-After；
 *   7. 输出 JSON 报告（含每个断言 PASS/FAIL 与未达标项）。
 *
 * 用法：
 *   node ops/loadtest.mjs --users 50 --duration 30 --rate 10
 *   node ops/loadtest.mjs --users 100 --duration 30 --rate 10
 *   node ops/loadtest.mjs --users 50 --duration 30 --rate 10 --report <file.json>
 *
 * 参数：
 *   --users      用户数与 WS 连接数（默认 50）
 *   --duration   持续秒数（默认 30）
 *   --rate       消息发送速率 msg/s（默认 10）
 *   --probe-rate REST 探测速率 req/s（默认 4，受全局 200/min 限流约束）
 *   --report     额外写 JSON 报告到文件
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败/未达标；2 = 参数或环境错误。
 *
 * 基线（需求书给定）：REST p95 ≤ 500ms；到达 p95 ≤ 1000ms。
 *
 * 注意：本脚本只操作临时目录里的库，不读写任何 .data/ 生产库。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

import WebSocket from 'ws';

import { buildApp } from '../dist/src/app.js';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'loadtest-password-1';

function parseArgs(argv) {
  const args = { users: 50, duration: 30, rate: 10, probeRate: 4, report: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} 缺少参数值`);
      index += 1;
      return value;
    };
    if (token === '--users') args.users = Number(takeValue());
    else if (token === '--duration') args.duration = Number(takeValue());
    else if (token === '--rate') args.rate = Number(takeValue());
    else if (token === '--probe-rate') args.probeRate = Number(takeValue());
    else if (token === '--report') args.report = takeValue();
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`未知参数: ${token}`);
  }
  if (args.help) return args;
  for (const key of ['users', 'duration', 'rate', 'probeRate']) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) throw new Error(`--${key} 必须是正数`);
  }
  if (args.users > 200) throw new Error('--users 上限 200（本机演练目的）');
  return args;
}

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

function stats(input) {
  const values = [...input].sort((a, b) => a - b);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    min: values.length ? Number(values[0].toFixed(2)) : null,
    p50: percentile(values, 50) === null ? null : Number(percentile(values, 50).toFixed(2)),
    p95: percentile(values, 95) === null ? null : Number(percentile(values, 95).toFixed(2)),
    p99: percentile(values, 99) === null ? null : Number(percentile(values, 99).toFixed(2)),
    max: values.length ? Number(values[values.length - 1].toFixed(2)) : null,
    mean: values.length ? Number((sum / values.length).toFixed(2)) : null,
  };
}

/** 直连库 seed：用户 + session + 一个全员群聊（绕过注册/登录限流） */
async function seed(databasePath, users) {
  const { hashPassword, opaqueToken, digest } = await import('../dist/src/security.js');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const passwordHash = await hashPassword(PASSWORD);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const people = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < users; index += 1) {
      const id = randomUUID();
      const username = `loaduser${index}`;
      database.prepare(`INSERT INTO users(id, username, display_name, avatar_url, bio, password_hash, created_at)
        VALUES (?, ?, ?, '', '', ?, ?)`).run(id, username, `Load ${index}`, passwordHash, now);
      const token = opaqueToken();
      database.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(digest(token), id, expiresAt, now);
      people.push({ id, username, token, sessionHash: digest(token) });
    }
    const conversationId = randomUUID();
    database.prepare(`INSERT INTO conversations(id, type, name, owner_id, created_at, updated_at)
      VALUES (?, 'group', 'loadtest-group', ?, ?, ?)`).run(conversationId, people[0].id, now, now);
    for (const person of people) {
      database.prepare('INSERT INTO conversation_members(conversation_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(conversationId, person.id, now);
    }
    database.exec('COMMIT');
    return { conversationId, people };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

/** 打开一条 WS 连接，返回 ready 后可用 */
function openSocket(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url, { origin: ORIGIN, handshakeTimeout: 10_000 });
    const timeout = setTimeout(() => {
      socket.terminate();
      rejectPromise(new Error('WS 连接/ready 超时（10s）'));
    }, 10_000);
    socket.on('error', error => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    socket.on('close', (code, reason) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`WS 关闭 ${code} ${reason.toString()}`));
    });
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'ready') {
        clearTimeout(timeout);
        socket.removeAllListeners('error');
        resolvePromise({ socket, ready: event });
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node ops/loadtest.mjs --users 50 --duration 30 --rate 10');
    return 0;
  }

  const root = mkdtempSync(join(tmpdir(), 'aitrance-load-'));
  const databasePath = join(root, 'loadtest.sqlite');

  const report = {
    tool: 'ops/loadtest.mjs',
    node: process.version,
    startedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    params: { users: args.users, durationSeconds: args.duration, targetRate: args.rate, probeRate: args.probeRate },
    baseline: { restP95Ms: 500, arrivalP95Ms: 1000 },
    instance: {},
    connections: {},
    messages: {},
    rest: {},
    arrival: {},
    sequencing: {},
    boundaries: {},
    checks: [],
    ok: false,
  };
  const checks = report.checks;
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    return Boolean(ok);
  };

  let app = null;
  const sockets = [];
  try {
    const buildStart = performance.now();
    app = await buildApp({ databasePath, logger: false });
    await app.app.ready();
    const listenStart = performance.now();
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.app.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsBase = `ws://127.0.0.1:${address.port}`;
    report.instance = {
      baseUrl,
      buildAndReadyMs: Math.round(listenStart - buildStart),
      listenMs: Math.round(performance.now() - listenStart),
      databasePath,
    };

    const { conversationId, people } = await seed(databasePath, args.users);
    report.instance.conversationId = conversationId;
    report.instance.seededUsers = people.length;

    // ---------- WS 连接（每条一个一次性 ticket） ----------
    const connectionStart = performance.now();
    const readyPayloads = [];
    for (const person of people) {
      const ticketResponse = await fetch(`${baseUrl}/api/v1/auth/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${person.token}`, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      });
      if (ticketResponse.status !== 200) throw new Error(`ws-ticket 失败 HTTP ${ticketResponse.status}`);
      const { ticket } = await ticketResponse.json();
      const { socket, ready } = await openSocket(`${wsBase}/ws?ticket=${ticket}&v=1`);
      readyPayloads.push(ready);
      sockets.push({ socket, person, arrivals: [], seqs: new Set(), duplicates: 0, errors: 0 });
    }
    const connectionMs = Math.round(performance.now() - connectionStart);
    report.connections = {
      requested: args.users,
      established: sockets.length,
      durationMs: connectionMs,
      readyAllProtocolVersion1: readyPayloads.every(payload => payload?.data?.protocolVersion === 1),
    };
    // 每个客户端收到的所有 message.created 帧
    const frameCount = { value: 0 };
    const arrivalTimes = [];
    const sendsBySender = new Map();
    const sendTimes = new Map(); // clientMsgId -> { t0, senderId }
    for (const client of sockets) {
      client.socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type !== 'message.created') return;
        frameCount.value += 1;
        const clientMsgId = event.data?.message?.clientMsgId;
        const sent = sendTimes.get(clientMsgId);
        if (sent) arrivalTimes.push(performance.now() - sent.t0);
        client.arrivals.push(performance.now());
        const seq = event.data?.message?.seq;
        if (client.seqs.has(seq)) client.duplicates += 1;
        client.seqs.add(seq);
      });
    }

    // ---------- 持续发消息 ----------
    const startedAt = performance.now();
    const deadline = startedAt + args.duration * 1000;
    const interval = 1000 / args.rate;
    let sendIndex = 0;
    let httpCreated = 0;
    let httpIdempotent = 0;
    const httpFailures = [];
    const restLatencies = []; // 发消息请求自身耗时
    const sendPromises = [];

    const sendOne = async () => {
      const sender = people[sendIndex % people.length];
      sendIndex += 1;
      const clientMsgId = randomUUID();
      const t0 = performance.now();
      sendTimes.set(clientMsgId, { t0, senderId: sender.id });
      sendsBySender.set(sender.username, (sendsBySender.get(sender.username) ?? 0) + 1);
      try {
        const response = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${sender.token}`,
            origin: ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ clientMsgId, type: 'text', content: `load-${clientMsgId.slice(0, 8)}` }),
        });
        const elapsed = performance.now() - t0;
        restLatencies.push(elapsed);
        if (response.status === 201) httpCreated += 1;
        else if (response.status === 200) httpIdempotent += 1;
        else httpFailures.push({ status: response.status, body: (await response.text()).slice(0, 200) });
        await response.arrayBuffer();
      } catch (error) {
        httpFailures.push({ status: 0, body: error instanceof Error ? error.message : String(error) });
      }
    };

    // 探测：GET /health 与 GET /api/v1/auth/session 交错
    const probeLatencies = { health: [], session: [] };
    let probeRunning = true;
    const probeLoop = (async () => {
      let round = 0;
      while (probeRunning && performance.now() < deadline + 200) {
        const probePerson = people[people.length - 1];
        const target = round % 2 === 0
          ? { name: 'health', url: `${baseUrl}/health`, headers: { origin: ORIGIN } }
          : { name: 'session', url: `${baseUrl}/api/v1/auth/session`, headers: { authorization: `Bearer ${probePerson.token}`, origin: ORIGIN } };
        round += 1;
        const t0 = performance.now();
        try {
          const response = await fetch(target.url, { headers: target.headers });
          await response.arrayBuffer();
          probeLatencies[target.name].push(performance.now() - t0);
        } catch {
          /* 丢弃失败的探测样本 */
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1000 / args.probeRate));
      }
    })();

    // 定时发送（用 setTimeout 链，避免 drift 累积成 burst）
    const loop = (async () => {
      while (performance.now() < deadline) {
        const due = startedAt + (sendIndex / args.rate) * 1000;
        sendPromises.push(sendOne());
        const wait = due + interval - performance.now();
        if (wait > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, wait));
        else await new Promise(resolvePromise => setImmediate(resolvePromise));
      }
    })();

    await loop;
    await Promise.all(sendPromises);
    probeRunning = false;
    await probeLoop;
    // 等最后一批帧到达（最多 3s）
    const drainDeadline = performance.now() + 3000;
    while (frameCount.value < httpCreated * sockets.length && performance.now() < drainDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    const elapsedSeconds = (performance.now() - startedAt) / 1000;

    // ---------- 汇总 ----------
    const dbCount = app.store.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId).n;
    report.messages = {
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      achievedRate: Number((httpCreated / elapsedSeconds).toFixed(2)),
      httpCreated,
      httpIdempotent,
      httpFailures: httpFailures.slice(0, 5),
      httpFailureCount: httpFailures.length,
      dbMessageCount: dbCount,
      senderCount: sendsBySender.size,
      maxSendsPerSender: Math.max(0, ...sendsBySender.values()),
    };
    report.rest = {
      sendRequestMs: stats(restLatencies),
      healthMs: stats(probeLatencies.health),
      sessionMs: stats(probeLatencies.session),
      combinedMs: stats([...probeLatencies.health, ...probeLatencies.session]),
    };
    const arrivalSorted = arrivalTimes;
    report.arrival = { ...stats(arrivalSorted), frames: frameCount.value };

    // seq 连续性：每个客户端收到的 seq 集合应 = 1..dbCount（无 system 消息，seed 直插群聊不产生 system）
    let clientsWithGaps = 0;
    let clientsWithDuplicates = 0;
    let maxMissing = 0;
    for (const client of sockets) {
      const missing = dbCount - client.seqs.size;
      if (missing !== 0) clientsWithGaps += 1;
      maxMissing = Math.max(maxMissing, Math.abs(missing));
      if (client.duplicates > 0) clientsWithDuplicates += 1;
    }
    report.sequencing = {
      expectedSeqsPerClient: dbCount,
      clientsWithGaps,
      maxMissingPerClient: maxMissing,
      clientsWithDuplicates,
      totalDuplicateFrames: sockets.reduce((acc, client) => acc + client.duplicates, 0),
    };
    check(
      'seq 无缺失（每个客户端收到全部 dbCount 条）',
      clientsWithGaps === 0,
      report.sequencing,
    );
    check('seq 无重复', sockets.reduce((acc, client) => acc + client.duplicates, 0) === 0, report.sequencing);

    // 发送速率是否达标（±10%）
    check(
      `实测发送速率达到目标 ${args.rate} msg/s（±10%）`,
      Math.abs(httpCreated / elapsedSeconds - args.rate) / args.rate <= 0.1,
      { achieved: report.messages.achievedRate, target: args.rate },
    );
    check(
      `REST p95 ≤ ${report.baseline.restP95Ms}ms`,
      (report.rest.sendRequestMs.p95 ?? Infinity) <= report.baseline.restP95Ms,
      report.rest.sendRequestMs,
    );
    check(
      `到达 p95 ≤ ${report.baseline.arrivalP95Ms}ms`,
      (report.arrival.p95 ?? Infinity) <= report.baseline.arrivalP95Ms,
      report.arrival,
    );
    check('无 HTTP 失败（非 2xx）', httpFailures.length === 0, report.messages.httpFailures);

    // ---------- 边界 1：单用户第 6 条 WS 连接 → close 1008 ----------
    const boundaryPerson = people[0];
    const extraSockets = [];
    const boundaryResult = { perUserConnectionLimit: 5, closes: [] };
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const ticketResponse = await fetch(`${baseUrl}/api/v1/auth/ws-ticket`, {
          method: 'POST',
          headers: { authorization: `Bearer ${boundaryPerson.token}`, origin: ORIGIN, 'content-type': 'application/json' },
          body: '{}',
        });
        const { ticket } = await ticketResponse.json();
        const socket = new WebSocket(`${wsBase}/ws?ticket=${ticket}&v=1`, { origin: ORIGIN });
        extraSockets.push(socket);
        const outcome = await new Promise(resolvePromise => {
          const timer = setTimeout(() => resolvePromise({ opened: true, timeout: true }), 1500);
          socket.on('close', (code, reason) => {
            clearTimeout(timer);
            resolvePromise({ opened: false, code, reason: reason.toString() });
          });
          socket.on('error', () => {});
        });
        boundaryResult.closes.push(outcome);
        // 已被服务端拒绝的连接不再保留
        if (!outcome.opened) socket.terminate();
      }
    } finally {
      for (const socket of extraSockets) {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    const rejected = boundaryResult.closes.filter(item => !item.opened && item.code === 1008);
    boundaryResult.rejectedCount = rejected.length;
    boundaryResult.rejectReason = rejected[0]?.reason ?? null;
    report.boundaries.perUserConnectionLimit = boundaryResult;
    check('单用户第 6 条 WS 连接被 close 1008 拒绝', rejected.length >= 1, boundaryResult);

    // ---------- 边界 2：单用户高频发消息 → 429 + Retry-After ----------
    const floodPerson = people[people.length - 1];
    const flood = { attempts: 0, statuses: {}, first429At: null, retryAfter: null, rateLimitHeaders: null };
    for (let attempt = 0; attempt < 80; attempt += 1) {
      flood.attempts += 1;
      const response = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${floodPerson.token}`, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ clientMsgId: randomUUID(), type: 'text', content: `flood-${attempt}` }),
      });
      flood.statuses[response.status] = (flood.statuses[response.status] ?? 0) + 1;
      if (response.status === 429 && flood.first429At === null) {
        flood.first429At = attempt + 1;
        flood.retryAfter = response.headers.get('retry-after');
        flood.rateLimitHeaders = {
          limit: response.headers.get('x-ratelimit-limit'),
          remaining: response.headers.get('x-ratelimit-remaining'),
          reset: response.headers.get('x-ratelimit-reset'),
        };
        const body = await response.json().catch(() => null);
        flood.errorBody = body;
      } else {
        await response.arrayBuffer();
      }
    }
    report.boundaries.rateLimit = flood;
    check('突发发送触发 429', flood.first429At !== null, { first429At: flood.first429At, statuses: flood.statuses });
    check('429 响应带 Retry-After 头', Boolean(flood.retryAfter), { retryAfter: flood.retryAfter, headers: flood.rateLimitHeaders });

    report.ok = checks.every(item => item.ok);
    return report;
  } finally {
    for (const socket of sockets) {
      try {
        socket.socket.terminate();
      } catch {
        /* ignore */
      }
    }
    if (app) await app.app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(report => {
    const payload = JSON.stringify(report, null, 2);
    console.log(payload);
    const args = parseArgs(process.argv.slice(2));
    if (args.report) writeFileSync(resolve(args.report), `${payload}\n`, 'utf8');
    process.exitCode = report.ok ? 0 : 1;
  })
  .catch(error => {
    console.error(
      JSON.stringify(
        { tool: 'ops/loadtest.mjs', ok: false, error: error instanceof Error ? error.message : String(error), stack: error?.stack },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
