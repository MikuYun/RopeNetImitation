import { buildApp } from './app.ts';

const { app, config, transport } = await buildApp();

/**
 * SEC-01：把实际生效的传输模式写进启动日志，便于运维一眼确认
 * 「到底是我这个进程终结 TLS，还是交给 nginx」。不启用 TLS 时行为与改动前完全一致（http）。
 */
app.log.info({
  transport,
  requireHttps: config.requireHttps,
  retentionSweepSeconds: config.retentionSweepSeconds,
  retentionMessageDays: config.retentionMessageDays,
}, `Chat backend transport: ${transport}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
