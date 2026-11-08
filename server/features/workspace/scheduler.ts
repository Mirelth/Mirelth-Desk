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
      // 逐任务隔离：一条任务抛错（例如执行期间被删）不能连坐本轮剩下的任务。
      try {
        await workspaceService.runTask(task.user_id, task.id);
      } catch (error) {
        logger.error('automation.task_failed', {
          task_id: task.id,
          action: task.action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
