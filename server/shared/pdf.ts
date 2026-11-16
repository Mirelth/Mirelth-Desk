/**
 * PDF → 文本/Markdown。用 pdfjs-dist 的 legacy 构建在 Node 侧解析。
 * 有文本层时直接提取；扫描件（无文本层）由 `renderPdfPages` 转图后交多模态模型识别。
 */
import { config } from './config.ts';
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

export interface RenderedPage { page: number; base64: string; mime: string }

/**
 * 把 PDF 逐页渲染成 PNG，供多模态模型识别扫描件。
 * 用 pdfjs 官方推荐的 @napi-rs/canvas（预编译二进制，无需本地编译工具链）。
 * 页数受 VISION_MAX_PAGES 限制：一次任务传太多图会超时且费用失控。
 */
export async function renderPdfPages(buffer: Buffer, maxPages = config.vision.maxPages): Promise<RenderedPage[]> {
  const pdfjs = await loadPdfjs();
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const doc = await task.promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new BadRequestError('该 PDF 已加密，请先解除密码后再导入');
    throw new BadRequestError('无法解析该文件，请确认是有效的 PDF 文档');
  });

  const total = doc.numPages;
  const limit = Math.min(total, Math.max(maxPages, 1));
  const rendered: RenderedPage[] = [];
  try {
    for (let index = 1; index <= limit; index += 1) {
      const page = await doc.getPage(index);
      const viewport = page.getViewport({ scale: config.vision.scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      // pdfjs 的 canvas 接口与 DOM 略有差异，这里只用它需要的最小面。
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: canvas as unknown as HTMLCanvasElement,
      }).promise;
      rendered.push({ page: index, base64: canvas.toBuffer('image/png').toString('base64'), mime: 'image/png' });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return rendered;
}

/** 只读页数，供调用方判断是否超出识别上限并给出提示。 */
export async function pdfPageCount(buffer: Buffer): Promise<number> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  try {
    const doc = await task.promise;
    return doc.numPages;
  } catch {
    throw new BadRequestError('无法解析该文件，请确认是有效的 PDF 文档');
  } finally {
    await task.destroy();
  }
}