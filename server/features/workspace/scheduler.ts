import { logger } from '../../shared/logger.ts';
import { workspaceRepository } from './workspace.repository.ts';
import { workspaceService } from './workspace.service.ts';

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = workspaceRepository.dueTasks(new Date().toISOString());
    for (const task of due) {
      await workspaceService.runTask(task.user_id, task.id);
    }
    if (due.length) logger.info('automation.scheduler_tick', { executed: due.length });
  } catch (error) {
    logger.error('automation.scheduler_failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    ticking = false;
  }
}

export function startAutomationScheduler(): () => void {
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  logger.info('automation.scheduler_started', { interval_seconds: 60 });
  return () => clearInterval(timer);
}
