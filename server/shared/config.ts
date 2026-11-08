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
    password: stringValue('ADMIN_PASSWORD', 'admin123'),
  },
  llm: {
    baseUrl: stringValue('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env('LLM_API_KEY') ?? '',
    model: stringValue('LLM_MODEL', 'gpt-4o-mini'),
    get enabled(): boolean {
      return Boolean(this.apiKey);
    },
  },
  database: {
    path: path.resolve(ROOT, stringValue('DATABASE_PATH', '.data/mirelth.db')),
  },
} as const;

export type AppConfig = typeof config;
