import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../shared/config.ts';
import { recentLogs } from '../../shared/logger.ts';

/** `package.json` 的版本号是「检查更新」的唯一真相，只读一次。 */
let cachedVersion = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')) as { version?: string };
  cachedVersion = pkg.version ?? cachedVersion;
} catch {
  // 读不到就用兜底版本号，不要让「检查更新」把整个服务带崩。
}

const startedAt = new Date();

export const systemService = {
  info() {
    return {
      version: cachedVersion,
      build: 'local' as const,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      env: config.nodeEnv,
      aiMode: config.llm.enabled ? 'live' as const : 'offline' as const,
      model: config.llm.enabled ? config.llm.model : '本地规则引擎',
      updatesUrl: process.env.UPDATES_URL ?? null,
    };
  },

  /**
   * 日志打包：一份可直接贴给支持者的纯文本。只含版本/环境/最近日志，
   * **不含**账号口令、模型密钥、邮件凭据——排查问题用不到它们。
   */
  logBundle(): { filename: string; body: string } {
    const info = this.info();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const header = [
      '# Mirelth Desk 诊断日志',
      `版本: v${info.version}（${info.build}）`,
      `环境: ${info.env} · Node ${info.node} · ${info.platform}`,
      `启动时间: ${info.startedAt}（已运行 ${info.uptimeSeconds} 秒）`,
      `引擎: ${info.aiMode} · ${info.model}`,
      `生成时间: ${new Date().toISOString()}`,
      '',
      '## 最近日志（新→旧顺序之外，本段为旧→新）',
      '',
    ].join('\n');
    const lines = recentLogs(500);
    return {
      filename: `mirelth-desk-logs-${stamp}.txt`,
      body: `${header}${lines.join('\n')}\n`,
    };
  },
};
