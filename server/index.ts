import { createApp } from './app.ts';
import { config } from './shared/config.ts';
import { closeDatabase, migrate } from './shared/database.ts';
import { logger } from './shared/logger.ts';
import { seedDemoData, seedWorkspaceApps } from './shared/seed.ts';
import { authService } from './features/auth/auth.service.ts';
import { startAutomationScheduler } from './features/workspace/scheduler.ts';

migrate();
authService.ensureAdmin();
seedDemoData();
seedWorkspaceApps();
const stopScheduler = startAutomationScheduler();

const app = createApp();
// 只监听回环：默认安装的账号口令与 SQLite 里的全部业务数据都不应暴露给同网段。
const server = app.listen(config.port, '127.0.0.1', () => {
  logger.info('server.started', {
    port: config.port,
    host: '127.0.0.1',
    env: config.nodeEnv,
    ai_mode: config.llm.enabled ? 'live' : 'offline',
  });
  if (!config.isProduction) {
    logger.info('server.hint', { url: `http://127.0.0.1:${config.port}/health`, frontend: config.clientOrigins[0] });
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { signal });
  stopScheduler();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('server.shutdown_forced');
    process.exit(1);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
