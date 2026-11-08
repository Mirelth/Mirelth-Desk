import { generate } from '../../ai/provider.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { activityService } from '../activity/activity.service.ts';
import { papersRepository, type PaperRow } from './papers.repository.ts';

export interface PaperInputDto {
  title: string;
  authors?: string;
  year?: number | null;
  venue?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  tags?: string[];
  status?: 'unread' | 'reading' | 'read';
  rating?: number;
  notes?: string;
}

function toDto(row: PaperRow) {
  return {
    id: row.id, title: row.title, authors: row.authors, year: row.year, venue: row.venue,
    doi: row.doi, url: row.url, abstract: row.abstract, tags: JSON.parse(row.tags) as string[],
    status: row.status, rating: row.rating, notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

type PaperDto = ReturnType<typeof toDto>;

function bibKey(paper: PaperDto, index: number): string {
  const firstAuthor = (paper.authors.split(/[,，;]/)[0] ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 12) || 'ref';
  return `${firstAuthor.toLowerCase()}${paper.year ?? ''}${index + 1}`;
}

function parseBibtex(source: string): PaperInputDto[] {
  const entries = source.split(/@\w+\s*\{/).slice(1);
  const result: PaperInputDto[] = [];
  for (const entry of entries) {
    const read = (field: string): string => {
      const match = new RegExp(`${field}\\s*=\\s*[{"]([\\s\\S]*?)[}"]\\s*,?`, 'i').exec(entry);
      return match?.[1]?.replace(/[{}]/g, '').trim() ?? '';
    };
    const title = read('title');
    if (!title) continue;
    const year = Number.parseInt(read('year'), 10);
    result.push({
      title, authors: read('author').replace(/\band\b/g, ';'), year: Number.isFinite(year) ? year : null,
      venue: read('journal') || read('booktitle') || read('publisher'), doi: read('doi'),
      url: read('url'), abstract: read('abstract'), tags: ['导入'],
    });
  }
  return result;
}

export const papersService = {
  /** 全量：统计 / 导出 / AI 用（不受分页影响）。 */
  list(userId: string, filters: { q?: string; status?: string; tag?: string } = {}) {
    return papersRepository.all(userId, filters).map(toDto);
  },

  page(userId: string, filters: { q?: string; status?: string; tag?: string }, page: { limit: number; offset: number }) {
    return {
      items: papersRepository.page(userId, filters, page).map(toDto),
      total: papersRepository.count(userId, filters),
      limit: page.limit,
      offset: page.offset,
    };
  },

  stats(userId: string) {
    const papers = this.list(userId);
    return {
      total: papers.length,
      unread: papers.filter((paper) => paper.status === 'unread').length,
      reading: papers.filter((paper) => paper.status === 'reading').length,
      read: papers.filter((paper) => paper.status === 'read').length,
      tags: [...new Set(papers.flatMap((paper) => paper.tags))].slice(0, 20),
      years: papers.map((paper) => paper.year).filter((year): year is number => Boolean(year)),
    };
  },

  get(userId: string, id: string): PaperDto {
    const row = papersRepository.find(userId, id);
    if (!row) throw new NotFoundError('文献', id);
    return toDto(row);
  },

  create(userId: string, input: PaperInputDto): PaperDto {
    const id = newId('pap');
    papersRepository.create({
      id, userId, title: input.title, authors: input.authors ?? '', year: input.year ?? null,
      venue: input.venue ?? '', doi: input.doi ?? '', url: input.url ?? '', abstract: input.abstract ?? '',
      tags: input.tags ?? [], status: input.status ?? 'unread', rating: input.rating ?? 0,
      notes: input.notes ?? '', createdAt: now(),
    });
    activityService.record(userId, 'paper', 'create', `收录文献「${input.title}」`);
    return this.get(userId, id);
  },

  update(userId: string, id: string, input: Partial<PaperInputDto>): PaperDto {
    this.get(userId, id);
    papersRepository.update(userId, id, {
      title: input.title, authors: input.authors, year: input.year, venue: input.venue,
      doi: input.doi, url: input.url, abstract: input.abstract, status: input.status,
      rating: input.rating, notes: input.notes,
      tagsJson: input.tags === undefined ? undefined : JSON.stringify(input.tags),
    });
    activityService.record(userId, 'paper', 'update', `更新文献 ${id}`);
    return this.get(userId, id);
  },

  remove(userId: string, id: string): void {
    this.get(userId, id);
    papersRepository.remove(userId, id);
    activityService.record(userId, 'paper', 'delete', `移除文献 ${id}`);
  },

  importBibtex(userId: string, source: string) {
    const parsed = parseBibtex(source);
    if (!parsed.length) throw new BadRequestError('未从 BibTeX 中解析出有效条目');
    let created = 0, skipped = 0;
    for (const paper of parsed) {
      if (papersRepository.countByTitle(userId, paper.title) > 0) { skipped += 1; continue; }
      this.create(userId, paper);
      created += 1;
    }
    activityService.record(userId, 'paper', 'import', `从 BibTeX 导入 ${created} 篇文献`);
    return { created, skipped, total: parsed.length };
  },

  export(userId: string, format: 'bibtex' | 'ris' | 'apa'): { filename: string; content: string; mime: string } {
    const papers = this.list(userId);
    let content = '';
    if (format === 'bibtex') {
      content = papers.map((paper, index) => [
        `@article{${bibKey(paper, index)},`,
        `  title   = {${paper.title}},`,
        `  author  = {${paper.authors.replace(/;/g, ' and ')}},`,
        `  year    = {${paper.year ?? ''}},`,
        `  journal = {${paper.venue}},`,
        paper.doi ? `  doi     = {${paper.doi}},` : '',
        `  url     = {${paper.url}}`, '}', '',
      ].filter(Boolean).join('\n')).join('\n');
    } else if (format === 'ris') {
      content = papers.map((paper) => [
        'TY  - JOUR', `TI  - ${paper.title}`,
        ...paper.authors.split(/[;，]/).filter(Boolean).map((author) => `AU  - ${author.trim()}`),
        `PY  - ${paper.year ?? ''}`, `JO  - ${paper.venue}`,
        paper.doi ? `DO  - ${paper.doi}` : '', `UR  - ${paper.url}`,
        paper.abstract ? `AB  - ${paper.abstract}` : '', 'ER  - ', '',
      ].filter(Boolean).join('\n')).join('\n');
    } else {
      content = papers.map((paper) =>
        `${paper.authors || '作者待补充'} (${paper.year ?? '年份待补充'}). ${paper.title}. ${paper.venue || '出处待补充'}.${paper.doi ? ` https://doi.org/${paper.doi}` : ''}`
      ).join('\n\n');
    }
    return { filename: `references.${format === 'apa' ? 'txt' : format}`, content, mime: 'text/plain' };
  },

  async ai(userId: string, kind: 'summary' | 'review' | 'synthesize', filters: { tag?: string; status?: string } = {}) {
    const papers = this.list(userId, filters);
    const result = await generate(
      kind === 'summary' ? 'paper.summary' : kind === 'review' ? 'paper.review' : 'paper.synthesize',
      { papers: papers.slice(0, 40), filter: filters },
    );
    activityService.record(userId, 'agent', 'paper_ai', `生成文献${kind === 'summary' ? '脉络分析' : kind === 'review' ? '综述大纲' : '综述初稿'}`);
    return result;
  },
};
