import { Router } from 'express';
import { asyncHandler } from '../../shared/http.ts';
import { systemService } from './system.service.ts';

export const systemRouter = Router();

systemRouter.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json({ data: systemService.info() });
  }),
);

/** 日志打包：走 `content-disposition`，客户端用 `downloadFile` 收，不解 `{ data }` 信封。 */
systemRouter.get(
  '/logs',
  asyncHandler(async (_req, res) => {
    const bundle = systemService.logBundle();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename}"`);
    res.send(bundle.body);
  }),
);
