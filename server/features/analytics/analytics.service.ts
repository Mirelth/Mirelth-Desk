import { generate } from '../../ai/provider.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { OFFICE_MIME, decodeBase64File } from '../../shared/office.ts';
import { activityService } from '../activity/activity.service.ts';
import { analyticsRepository, type DatasetRow } from './analytics.repository.ts';
import { parseCsv, stringifyCsv, type CellValue, type DataRow } from './csv.ts';
import { buildXlsx, parseXlsx } from './xlsx.ts';
import { computeStats, describe, type ColumnInfo, type DatasetStats } from './analytics.stats.ts';

export type { ColumnInfo, DatasetStats };

function decode(row: DatasetRow): { headers: string[]; storedColumns: ColumnInfo[]; rows: DataRow[] } {
  return {
    headers: (JSON.parse(row.columns) as Array<{ name: string }>).map((column) => column.name),
    storedColumns: JSON.parse(row.columns) as ColumnInfo[],
    rows: JSON.parse(row.rows) as DataRow[],
  };
}

export const analyticsService = {
  page(userId: string, page: { limit: number; offset: number }) {
    return {
      items: analyticsRepository.list(userId, page).map((row) => ({
        id: row.id, name: row.name, filename: row.filename,
        rowCount: row.row_count, columnCount: (JSON.parse(row.columns) as unknown[]).length,
        createdAt: row.created_at,
      })),
      total: analyticsRepository.count(userId),
      limit: page.limit,
      offset: page.offset,
    };
  },

  /** 全量：自动化动作取「最近一个数据集」时用。 */
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

  store(userId: string, input: { name?: string; filename: string }, headers: string[], rows: DataRow[]) {
    const columns = describe(headers, rows);
    const id = newId('dst');
    analyticsRepository.create({
      id, userId, name: input.name?.trim() || input.filename.replace(/\.(csv|tsv|txt|xlsx)$/i, '') || '未命名数据集',
      filename: input.filename, columns, rows, createdAt: now(),
    });
    activityService.record(userId, 'analytics', 'upload', `导入数据集「${input.filename}」（${rows.length} 行）`);
    return this.get(userId, id);
  },

  create(userId: string, input: { name?: string; filename: string; csv: string }) {
    if (!input.csv || input.csv.length > 8_000_000) throw new BadRequestError('CSV 内容为空或超过 8MB');
    const { headers, rows } = parseCsv(input.csv);
    return this.store(userId, input, headers, rows);
  },

  async createFromXlsx(userId: string, input: { name?: string; filename: string; contentBase64: string }) {
    if (!/\.xlsx$/i.test(input.filename)) throw new BadRequestError('仅支持 .xlsx 文件（旧版 .xls 请先另存为 .xlsx）');
    const buffer = decodeBase64File(input.contentBase64, 'Excel 文件');
    const { headers, rows } = await parseXlsx(buffer);
    return this.store(userId, input, headers, rows);
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

  async exportXlsx(userId: string, id: string): Promise<{ filename: string; content: Buffer; mime: string }> {
    const row = analyticsRepository.find(userId, id);
    if (!row) throw new NotFoundError('数据集', id);
    const { headers, rows } = decode(row);
    activityService.record(userId, 'analytics', 'export', `导出 Excel「${row.name}」`);
    return {
      filename: `${row.name.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`,
      content: await buildXlsx(row.name, headers, rows as DataRow[]),
      mime: OFFICE_MIME.xlsx,
    };
  },
};

export type { CellValue, DataRow };
