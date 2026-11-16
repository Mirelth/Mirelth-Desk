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
  /**
   * 插件（用户自配的外部工具）。出站**默认拒绝全部**：白名单为空即拒，
   * 与 browser 同口径。插件只能是声明式 HTTP 调用，不执行任何代码。
   */
  plugins: {
    enabled: stringValue('PLUGINS_ENABLED', 'true') === 'true',
    allowedHosts: stringValue('PLUGINS_ALLOWED_HOSTS', '')
      .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
    /** 允许连本机/内网地址（自建 MCP 或内网服务）。默认关；开启后仍要求命中白名单。 */
    allowPrivateNetworks: stringValue('PLUGINS_ALLOW_PRIVATE_NETWORKS', 'false') === 'true',
    timeoutMs: intValue('PLUGINS_TIMEOUT_MS', 8000),
    maxResponseBytes: intValue('PLUGINS_MAX_RESPONSE_BYTES', 65_536),
    maxPerWorkspace: intValue('PLUGINS_MAX_PER_WORKSPACE', 30),
    /** 单个 MCP 插件最多引入多少远端工具，防止清单被远端撑爆。 */
    maxRemoteTools: intValue('PLUGINS_MAX_REMOTE_TOOLS', 20),
    /** 远端工具清单缓存时长（毫秒）。0 表示每次都拉取。 */
    remoteCacheMs: intValue('PLUGINS_REMOTE_CACHE_MS', 300_000),
  },
  /**
   * 向量检索索引。小规模全扫更准，超过阈值自动切「粗量化分桶 + 精排」。
   * `mode: 'auto'` 按片段数决定；'scan' 强制全扫（对照与小库）；'index' 强制走索引。
   */
  vector: {
    mode: stringValue('VECTOR_INDEX_MODE', 'auto'),
    /** 片段数超过此值才建索引；小库全扫更快也更准。 */
    autoThreshold: intValue('VECTOR_INDEX_THRESHOLD', 20_000),
    /** 桶数上限。实际取 min(此值, ceil(sqrt(片段数)))，避免小库桶比向量还多。 */
    buckets: intValue('VECTOR_BUCKETS', 256),
    /** 查询时探查的桶数（nprobe）。越大召回越高、越慢。 */
    probes: intValue('VECTOR_PROBES', 8),
    /** k-means 迭代轮数上限。 */
    trainIterations: intValue('VECTOR_TRAIN_ITERATIONS', 12),
    /** 训练采样上限：十万级库不必全量参与训练。 */
    trainSample: intValue('VECTOR_TRAIN_SAMPLE', 4096),
    /** 桶内不平衡到该比例时提示重建（最大桶 / 平均桶）。 */
    rebalanceRatio: Number(stringValue('VECTOR_REBALANCE_RATIO', '6')) || 6,
  },
  /**
   * 分层记忆。四层各有预算，召回时按层取而不是一锅端。
   *
   * `episodicEnabled` 默认**关闭**：它会把运行结果自动留痕为经验。
   * 虽然记的是客观执行事实（不是猜测用户意图），但仍是自动写入，
   * 必须让用户显式开启，与「记忆不自动猜测」的既有承诺一致。
   */
  memory: {
    workingTtlMinutes: intValue('MEMORY_WORKING_TTL_MINUTES', 120),
    workingMax: intValue('MEMORY_WORKING_MAX', 20),
    preferenceMax: intValue('MEMORY_PREFERENCE_MAX', 200),
    semanticMax: intValue('MEMORY_SEMANTIC_MAX', 300),
    episodicMax: intValue('MEMORY_EPISODIC_MAX', 200),
    episodicEnabled: stringValue('MEMORY_EPISODIC_ENABLED', 'false') === 'true',
    /** episodic 保留天数，超期自动清理（它是流水性质，不该无限堆积）。 */
    episodicTtlDays: intValue('MEMORY_EPISODIC_TTL_DAYS', 30),
    /** 召回总条数上限，防止记忆把提示词撑爆。 */
    recallTotal: intValue('MEMORY_RECALL_TOTAL', 8),
  },
  database: {
    path: path.resolve(ROOT, stringValue('DATABASE_PATH', '.data/mirelth.db')),
  },
  ai: {
    // 按天计数的模型调用配额，由 `platform` 的 engine 与 status 读取。
    dailyLimit: intValue('AI_DAILY_LIMIT', 200),
  },
  /**
   * 会话式智能体的执行预算与规划层。
   * `maxSteps` 是**硬上限**（防失控循环），智能体定义里的 max_steps 只能在此之内取值；
   * 关掉 planner/reflect 即退回原来的单段工具循环，便于对比与排障。
   */
  agent: {
    maxSteps: intValue('AGENT_MAX_STEPS', 24),
    defaultSteps: intValue('AGENT_DEFAULT_STEPS', 8),
    plannerEnabled: stringValue('AGENT_PLANNER_ENABLED', 'true') === 'true',
    reflectEnabled: stringValue('AGENT_REFLECT_ENABLED', 'true') === 'true',
    /** 反思后最多重排几次，避免「反思—重排」自激循环。 */
    maxRevisions: intValue('AGENT_MAX_REVISIONS', 2),
    /** 单次运行的墙钟上限，超出即收尾交付已有结果，不再继续调用模型。 */
    runTimeoutMs: intValue('AGENT_RUN_TIMEOUT_MS', 300_000),
  },
} as const;

export type AppConfig = typeof config;
