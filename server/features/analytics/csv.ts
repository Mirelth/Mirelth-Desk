import { BadRequestError } from '../../shared/errors.ts';

export type CellValue = string | number | null;
export type DataRow = Record<string, CellValue>;

export function parseCsv(raw: string): { headers: string[]; rows: DataRow[] } {
  const source = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\n') {
      record.push(field);
      if (record.some((cell) => cell.trim() !== '')) records.push(record);
      record = []; field = '';
      continue;
    }
    field += char;
  }
  record.push(field);
  if (record.some((cell) => cell.trim() !== '')) records.push(record);

  if (records.length < 2) throw new BadRequestError('CSV 至少需要表头与一行数据');
  const headers = records[0].map((header, index) => header.trim() || `列${index + 1}`);
  if (headers.length > 60) throw new BadRequestError('CSV 列数不能超过 60');
  if (records.length - 1 > 5000) throw new BadRequestError('单次最多导入 5000 行，请先抽样');
  const unique = new Set<string>();
  for (const header of headers) {
    if (unique.has(header)) throw new BadRequestError(`存在重复列名：${header}`);
    unique.add(header);
  }

  const rows: DataRow[] = records.slice(1).map((cells) => {
    const row: DataRow = {};
    headers.forEach((header, index) => {
      const value = (cells[index] ?? '').trim();
      if (value === '') { row[header] = null; return; }
      const numeric = Number(value.replace(/,/g, ''));
      row[header] = value !== '' && Number.isFinite(numeric) && /^-?[\d,]+(\.\d+)?$/.test(value) ? numeric : value;
    });
    return row;
  });
  return { headers, rows };
}

export function stringifyCsv(headers: string[], rows: DataRow[]): string {
  const escape = (value: CellValue): string => {
    if (value === null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => headers.map((header) => escape(row[header] ?? null)).join(','))].join('\n');
}
