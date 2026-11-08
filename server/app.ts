import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './shared/config.ts';
import { db } from './shared/database.ts';
import { errorHandler, requestIdMiddleware, requestLoggingMiddleware } from './shared/http.ts';
import { logger } from './shared/logger.ts';
import { authRouter } from './features/auth/auth.controller.ts';
import { authenticate } from './features/auth/auth.middleware.ts';
import { dashboardRouter } from './features/activity/activity.controller.ts';
import { documentsRouter } from './features/documents/documents.controller.ts';
import { analyticsRouter } from './features/analytics/analytics.controller.ts';
import { papersRouter } from './features/papers/papers.controller.ts';
import { researchRouter } from './features/research/research.controller.ts';
import { mailRouter } from './features/mail/mail.controller.ts';
import { agentRouter } from './features/agent/agent.controller.ts';
import { automationRouter, connectorsRouter } from './features/workspace/workspace.controller.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.clientOrigins, credentials: true }));
  app.use(requestIdMiddleware);
  app.use(requestLoggingMiddleware);
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'mirelth-desk', time: new Date().toISOString() });
  });
  app.get('/ready', (_req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.json({ status: 'ok', checks: { database: 'ok' } });
    } catch (error) {
      logger.error('readiness.database_failed', { error: String(error) });
      res.status(503).json({ status: 'degraded', checks: { database: 'failed' } });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api', authenticate);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/papers', papersRouter);
  app.use('/api/research', researchRouter);
  app.use('/api/mail', mailRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/automation', automationRouter);
  app.use('/api/connectors', connectorsRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ title: 'NOT_FOUND', status: 404, detail: '接口不存在' });
  });

  const dist = path.join(config.root, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
