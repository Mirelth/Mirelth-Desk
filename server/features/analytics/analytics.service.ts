import { generate } from '../../ai/provider.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { activityService } from '../activity/activity.service.ts';
import { analyticsRepository, type DatasetRow } from './analytics.repository.ts';
import { parseCsv, stringifyCsv, type CellValue, type DataRow } from './csv.ts';

export interface ColumnInfo {
  name: string;
  type: 'numeric' | 'categorical';
  missing: number;
  unique?: number;
  mean?: number;
  sum?: number;
  min?: number;
  max?: number;
  std?: number;
}

export interface DatasetStats {
  rowCount: number;
  columnCount: number;
  columns: ColumnInfo[];
  groups: Array<{ label: string; value: number; count: number }>;
  trend: Array<{ label: string; value: number }>;
  correlations: Array<{ pair: string; value: number }>;
}

const round = (value: number): number => Number(value.toFixed(2));

function describe(headers: string[], rows: DataRow[]): ColumnInfo[] {
  return headers.map((name) => {
    const values = rows.map((row) => row[name]);
    const present = values.filter((value): value is string | number => value !== null && value !== undefined && value !== '');
    const numeric = present.filter((value): value is number => typeof value === 'number');
    const isNumeric = present.length > 0 && numeric.length / present.length >= 0.7;
    const base: ColumnInfo = { name, type: isNumeric ? 'numeric' : 'categorical', missing: rows.length - present.length };
    if (!isNumeric) return { ...base, unique: new Set(present.map(String)).size };
    const nums = present.map(Number).filter(Number.isFinite);
    if (!nums.length) return base;
    const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
    const variance = nums.reduce((sum, value) => sum + (value - mean) ** 2, 0) / nums.length;
    return { ...base, mean: round(mean), sum: round(nums.reduce((a, b) => a + b, 0)), min: round(Math.min(...nums)), max: round(Math.max(...nums)), std: round(Math.sqrt(variance)) };
  });
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let numerator = 0, denA = 0, denB = 0;
  for (let index = 0; index < n; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    numerator += da * db;
    denA += da ** 2;
    denB += db ** 2;
  }
  return denA && denB ? round(numerator / Math.sqrt(denA * denB)) : 0;
}

export function computeStats(columns: ColumnInfo[], rows: DataRow[]): DatasetStats {
  const numericColumns = columns.filter((column) => column.type === 'numeric');
  const categoryColumns = columns.filter((column) => column.type === 'categorical');
  const primary = numericColumns[0];
  const groups: Array<{ label: string; value: number; count: number }> = [];
  const trend: Array<{ label: string; value: number }> = [];

  if (primary && categoryColumns.length) {
    const categoryName = categoryColumns[0].name;
    const bucket = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
      const label = String(row[categoryName] ?? '未分类');
      const value = Number(row[primary.name]);
      if (!Number.isFinite(value)) continue;
      const entry = bucket.get(label) ?? { sum: 0, count: 0 };
      entry.sum += value;
      entry.count += 1;
      bucket.set(label, entry);
    }
    for (const [label, entry] of bucket) {
      groups.push({ label, value: round(entry.sum / entry.count), count: entry.count });
    }
  }

  if (primary && categoryColumns.length) {
    const timeName = categoryColumns[0].name;
    const bucket = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
      const label = String(row[timeName] ?? '未分类');
      const value = Number(row[primary.name]);
      if (!Number.isFinite(value)) continue;
      const entry = bucket.get(label) ?? { sum: 0, count: 0 };
      entry.sum += value;
      entry.count += 1;
      bucket.set(label, entry);
    }
    for (const [label, entry] of bucket) trend.push({ label, value: round(entry.sum) });
  }
  if (!trend.length && primary) {
    rows.slice(0, 24).forEach((row, index) => {
      trend.push({ label: `第 ${index + 1} 行`, value: round(Number(row[primary.name]) || 0) });
    });
  }

  const correlations: Array<{ pair: string; value: number }> = [];
  for (let i = 0; i < numericColumns.length; i += 1) {
    for (let j = i + 1; j < numericColumns.length; j += 1) {
      const a = rows.map((row) => Number(row[numericColumns[i].name])).filter(Number.isFinite);
      const b = rows.map((row) => Number(row[numericColumns[j].name])).filter(Number.isFinite);
      if (a.length === b.length && a.length >= 3) {
        correlations.push({ pair: `${numericColumns[i].name} × ${numericColumns[j].name}`, value: pearson(a, b) });
      }
    }
  }
  return { rowCount: rows.length, columnCount: columns.length, columns, groups: groups.slice(0, 12), trend: trend.slice(0, 24), correlations: correlations.slice(0, 6) };
}

function decode(row: DatasetRow): { headers: string[]; storedColumns: ColumnInfo[]; rows: DataRow[] } {
  return {
    headers: (JSON.parse(row.columns) as Array<{ name: string }>).map((column) => column.name),
    storedColumns: JSON.parse(row.columns) as ColumnInfo[],
    rows: JSON.parse(row.rows) as DataRow[],
  };
}

export const analyticsService = {
  list(userId: string) {
    return analyticsRepository.list(userId).map((row) => ({
      id: row.id, name: row.name, filename: row.filename,
      rowCount: row.row_count, columnCount: (JSON.parse(row.columns) as unknown[]).length,
      createdAt: row.created_at,
    }));
  },

  get(userId: string, id: string) {
    const row = analyticsRepository.find(userId, id);
    if (!row) throw new NotFoundError('数据集', id);
    const { headers, storedColumns, rows } = decode(row);
    const columns = describe(headers, rows);
    return {
      id: row.id, name: row.name, filename: row.filename, createdAt: row.created_at,
      columns, rows: rows.slice(0, 200), stats: computeStats(columns, rows), storedColumns,
    };
  },

  create(userId: string, input: { name?: string; filename: string; csv: string }) {
    if (!input.csv || input.csv.length > 8_000_000) throw new BadRequestError('CSV 内容为空或超过 8MB');
    const { headers, rows } = parseCsv(input.csv);
    const columns = describe(headers, rows);
    const id = newId('dst');
    analyticsRepository.create({
      id, userId, name: input.name?.trim() || input.filename.replace(/\.(csv|tsv|txt)$/i, '') || '未命名数据集',
      filename: input.filename, columns, rows, createdAt: now(),
    });
    activityService.record(userId, 'analytics', 'upload', `导入数据集「${input.filename}」（${rows.length} 行）`);
    return this.get(userId, id);
  },

  remove(userId: string, id: string): void {
    if (!analyticsRepository.find(userId, id)) throw new NotFoundError('数据集', id);
    analyticsRepository.remove(userId, id);
    activityService.record(userId, 'analytics', 'delete', `删除数据集 ${id}`);
  },

  async insights(userId: string, id: string, kind: 'insights' | 'report') {
    const dataset = this.get(userId, id);
    const result = await generate(kind === 'report' ? 'analytics.report' : 'analytics.insights', {
      datasetName: dataset.name,
      rowCount: dataset.stats.rowCount,
      columns: dataset.stats.columns,
      groups: dataset.stats.groups,
      trend: dataset.stats.trend,
      correlations: dataset.stats.correlations,
    });
    activityService.record(userId, 'agent', 'analytics_ai', `为「${dataset.name}」生成${kind === 'report' ? '分析报告' : '数据洞察'}`);
    return result;
  },

  exportCsv(userId: string, id: string): { filename: string; content: string } {
    const row = analyticsRepository.find(userId, id);
    if (!row) throw new NotFoundError('数据集', id);
    const { headers, rows } = decode(row);
    return { filename: `${row.name.replace(/[\\/:*?"<>|]/g, '_')}.csv`, content: stringifyCsv(headers, rows as DataRow[]) };
  },
};

export type { CellValue, DataRow };
