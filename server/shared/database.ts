import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';
import { logger } from './logger.ts';

const migrationsDir = path.join(config.root, 'server', 'shared', 'migrations');

fs.mkdirSync(path.dirname(config.database.path), { recursive: true });

export const db = new DatabaseSync(config.database.path);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

export function migrate(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => String((row as Record<string, unknown>).version)),
  );
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN TRANSACTION;');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
      db.exec('COMMIT;');
      logger.info('database.migration_applied', { version: file });
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as SQLInputValue[]));
}

export function closeDatabase(): void {
  db.close();
}
