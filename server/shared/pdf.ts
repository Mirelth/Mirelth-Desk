/**
 * PDF → 文本/Markdown。用 pdfjs-dist 的 legacy 构建在 Node 侧解析，纯 JS、无原生依赖、不联网。
 * 只提取文本层；扫描件（无文本层）返回空并带标记，由调用方转 OCR。
 */
import { BadRequestError } from './errors.ts';

export interface PdfText {
  markdown: string;
  pages: number;
  /** 没有任何文本层——通常是扫描件或纯图片 PDF。 */
  needsOcr: boolean;
}

interface TextItem { str?: string; hasEOL?: boolean }

/** 动态 import：pdfjs 体积较大，只在真的用到 PDF 时加载。 */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export async function pdfToMarkdown(buffer: Buffer): Promise<PdfText> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // 不加载外部字体与资源，保证解析不触网。
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new BadRequestError('该 PDF 已加密，请先解除密码后再导入');
    throw new BadRequestError('无法解析该文件，请确认是有效的 PDF 文档');
  }

  const parts: string[] = [];
  let totalChars = 0;
  const pages = doc.numPages;
  try {
    for (let index = 1; index <= pages; index += 1) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let current = '';
      for (const item of content.items as TextItem[]) {
        if (typeof item.str !== 'string') continue;
        current += item.str;
        if (item.hasEOL) { lines.push(current.trim()); current = ''; }
      }
      if (current.trim()) lines.push(current.trim());
      const text = lines.filter(Boolean).join('\n');
      totalChars += text.length;
      if (text) parts.push(`## 第 ${index} 页\n\n${text}`);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  const markdown = parts.join('\n\n').trim();
  return {
    markdown,
    pages,
    needsOcr: totalChars < 20,
  };
}