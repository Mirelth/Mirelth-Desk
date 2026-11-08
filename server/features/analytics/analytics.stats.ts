import type { DataRow } from './csv.ts';

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

/** 单元格的数值形式；空单元格与非数字字符串都返回 undefined（不要用 Number()，它把 null 变成 0）。 */
function numericAt(row: DataRow, name: string): number | undefined {
  const value = row[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function describe(headers: string[], rows: DataRow[]): ColumnInfo[] {
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

export function pearson(a: number[], b: number[]): number {
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
      const value = numericAt(row, primary.name);
      if (value === undefined) continue;
      const label = String(row[categoryName] ?? '未分类');
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
      const value = numericAt(row, primary.name);
      if (value === undefined) continue;
      const label = String(row[timeName] ?? '未分类');
      const entry = bucket.get(label) ?? { sum: 0, count: 0 };
      entry.sum += value;
      entry.count += 1;
      bucket.set(label, entry);
    }
    for (const [label, entry] of bucket) trend.push({ label, value: round(entry.sum) });
  }
  if (!trend.length && primary) {
    rows.slice(0, 24).forEach((row, index) => {
      const value = numericAt(row, primary.name);
      if (value === undefined) return;
      trend.push({ label: `第 ${index + 1} 行`, value: round(value) });
    });
  }

  const correlations: Array<{ pair: string; value: number }> = [];
  for (let i = 0; i < numericColumns.length; i += 1) {
    for (let j = i + 1; j < numericColumns.length; j += 1) {
      // 按行取交集：任一列在该行缺失或非数字，整对跳过，避免两条序列错位配对。
      const left: number[] = [];
      const right: number[] = [];
      for (const row of rows) {
        const a = numericAt(row, numericColumns[i].name);
        const b = numericAt(row, numericColumns[j].name);
        if (a === undefined || b === undefined) continue;
        left.push(a);
        right.push(b);
      }
      if (left.length >= 3) {
        correlations.push({ pair: `${numericColumns[i].name} × ${numericColumns[j].name}`, value: pearson(left, right) });
      }
    }
  }
  return { rowCount: rows.length, columnCount: columns.length, columns, groups: groups.slice(0, 12), trend: trend.slice(0, 24), correlations: correlations.slice(0, 6) };
}
