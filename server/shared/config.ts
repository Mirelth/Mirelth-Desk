import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();

function loadDotEnv(): Record<string, string> {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const fileEnv = loadDotEnv();
const env = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

function stringValue(key: string, fallback: string): string {
  const value = env(key);
  return value === undefined || value === '' ? fallback : value;
}

function intValue(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer env var: ${key}`);
  return parsed;
}

function resolveSecret(isProduction: boolean): string {
  const configured = env('APP_SECRET');
  if (configured) {
    if (configured.length < 16) throw new Error('APP_SECRET must be at least 16 characters');
    return configured;
  }
  if (isProduction) throw new Error('APP_SECRET is required in production');
  const dataDir = path.join(ROOT, '.data');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, 'secret.key');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

/**
 * 未配置 ADMIN_PASSWORD 时随机生成初始口令并写入 .data/admin-password（0600），
 * 后续启动复用同一文件；不再使用任何内置默认口令。
 */
function resolveAdminPassword(): string {
  const configured = env('ADMIN_PASSWORD');
  if (configured) return configured;
  const dataDir = path.join(ROOT, '.data');
  fs.mkdirSync(dataDir, { recursive: true });
  const passwordFile = path.join(dataDir, 'admin-password');
  if (fs.existsSync(passwordFile)) {
    const existing = fs.readFileSync(passwordFile, 'utf8').trim();
    if (existing) return existing;
  }
  const generated = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(passwordFile, generated, { mode: 0o600 });
  return generated;
}

const nodeEnv = stringValue('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

export const config = {
  root: ROOT,
  nodeEnv,
  isProduction,
  port: intValue('PORT', 3001),
  clientOrigins: stringValue('CLIENT_ORIGIN', 'http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  secret: resolveSecret(isProduction),
  admin: {
    username: stringValue('ADMIN_USERNAME', 'admin'),
    password: resolveAdminPassword(),
  },
  llm: {
    baseUrl: stringValue('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env('LLM_API_KEY') ?? '',
    model: stringValue('LLM_MODEL', 'gpt-4o-mini'),
    /** 语义检索用的嵌入模型；留空则检索降级为词法向量，不影响可用性。 */
    embeddingModel: stringValue('LLM_EMBEDDING_MODEL', ''),
    /** 图片与扫描件识别用的多模态模型；留空则沿用 LLM_MODEL。 */
    visionModel: stringValue('LLM_VISION_MODEL', ''),
    get enabled(): boolean {
      return Boolean(this.apiKey);
    },
    get embeddingEnabled(): boolean {
      return Boolean(this.apiKey) && Boolean(this.embeddingModel);
    },
  },
  /** 浏览器自动化：默认关闭。开启后也只允许白名单内的站点，且只连回环调试端口。 */
  browser: {
    enabled: stringValue('BROWSER_ENABLED', 'false') === 'true',
    cdpUrl: stringValue('BROWSER_CDP_URL', 'http://127.0.0.1:9222'),
    allowedHosts: stringValue('BROWSER_ALLOWED_HOSTS', '')
      .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
    maxSteps: intValue('BROWSER_MAX_STEPS', 12),
    timeoutMs: intValue('BROWSER_TIMEOUT_MS', 30_000),
  },
  /** 扫描件识别：逐页转图交多模态模型，页数上限防止一次任务失控。 */
  vision: {
    maxPages: intValue('VISION_MAX_PAGES', 10),
    /** 渲染倍率：2 约等于 144dpi，兼顾清晰度与请求体积。 */
    scale: Number(stringValue('VISION_RENDER_SCALE', '2')) || 2,
  },
  database: {
    path: path.resolve(ROOT, stringValue('DATABASE_PATH', '.data/mirelth.db')),
  },
  ai: {
    // 按天计数的模型调用配额，由 `platform` 的 engine 与 status 读取。
    dailyLimit: intValue('AI_DAILY_LIMIT', 200),
  },
} as const;

export type AppConfig = typeof config;
