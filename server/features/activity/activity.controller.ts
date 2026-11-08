import { Router } from 'express';
import { asyncHandler, type AuthenticatedRequest } from '../../shared/http.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { activityService } from './activity.service.ts';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.json({ data: activityService.stats(currentUserId(req)) });
  }),
);

dashboardRouter.get(
  '/activity',
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10) || 20;
    res.json({ data: activityService.list(currentUserId(req), limit) });
  }),
);
