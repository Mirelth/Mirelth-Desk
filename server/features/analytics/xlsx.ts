/**
 * XLSX ↔ 数据集：与 csv.ts 同口径（≤60 列、≤5000 行、重复列名报错、数值自动识别）。
 * 只读第一个工作表；公式取计算结果，日期按 ISO 日期文本导入。
 */
import ExcelJS from 'exceljs';
import { BadRequestError } from '../../shared/errors.ts';
import type { CellValue, DataRow } from './csv.ts';

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return String(value.text);
    if ('error' in value) return '';
    return '';
  }
  return String(value);
}

function toCell(raw: string): CellValue {
  const value = raw.trim();
  if (value === '') return null;
  const numeric = Number(value.replace(/,/g, ''));
  return Number.isFinite(numeric) && /^-?[\d,]+(\.\d+)?$/.test(value) ? numeric : value;
}

export async function parseXlsx(buffer: Buffer): Promise<{ headers: string[]; rows: DataRow[] }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestError('无法解析该文件，请确认是有效的 .xlsx 工作簿');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestError('工作簿中没有工作表');

  const records: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    const count = Math.min(row.cellCount, 61);
    for (let index = 1; index <= count; index += 1) cells.push(cellText(row.getCell(index).value));
    while (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
    if (cells.some((cell) => cell.trim() !== '')) records.push(cells);
  });

  if (records.length < 2) throw new BadRequestError('XLSX 至少需要表头与一行数据');
  const headers = records[0].map((header, index) => header.trim() || `列${index + 1}`);
  if (headers.length > 60) throw new BadRequestError('XLSX 列数不能超过 60');
  if (records.length - 1 > 5000) throw new BadRequestError('单次最多导入 5000 行，请先抽样');
  const unique = new Set<string>();
  for (const header of headers) {
    if (unique.has(header)) throw new BadRequestError(`存在重复列名：${header}`);
    unique.add(header);
  }

  const rows: DataRow[] = records.slice(1).map((cells, rowIndex) => {
    const overflow = cells.slice(headers.length).filter((cell) => cell.trim() !== '');
    if (overflow.length) {
      throw new BadRequestError(`第 ${rowIndex + 2} 行有 ${overflow.length} 个多余的单元格（表头只有 ${headers.length} 列）`);
    }
    const row: DataRow = {};
    headers.forEach((header, index) => { row[header] = toCell(cells[index] ?? ''); });
    return row;
  });
  return { headers, rows };
}

export async function buildXlsx(name: string, headers: string[], rows: DataRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Mirelth Desk';
  const sheet = workbook.addWorksheet(name.replace(/[\\/*?[\]:]/g, '_').slice(0, 31) || '数据');
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) sheet.addRow(headers.map((header) => row[header] ?? null));
  headers.forEach((header, index) => {
    const longest = Math.max(header.length * 2, ...rows.slice(0, 200).map((row) => String(row[header] ?? '').length));
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 2, 10), 40);
  });
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}