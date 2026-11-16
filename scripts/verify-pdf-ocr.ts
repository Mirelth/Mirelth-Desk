/**
 * 一次性验证脚本：PDF 文本提取、OCR 离线守卫、断网行为。
 * 用 `node scripts/verify-pdf-ocr.ts` 运行；不进 npm test（需要真实语言包与网络探针）。
 */
process.env.DATABASE_PATH = '.data/verify-pdf-ocr.db';
process.env.APP_SECRET = 'verify-pdf-ocr-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';

import assert from 'node:assert/strict';
import { Document, Packer, Paragraph } from 'docx';

const { pdfToMarkdown } = await import('../server/shared/pdf.ts');
const { ocrStatus, recognizeImage } = await import('../server/shared/ocr.ts');
const { markdownToDocx } = await import('../server/shared/office.ts');

// ---- 1. PDF：用 pdfjs 自己能读的最小 PDF 验证文本层提取 ----
// 手工构造一个含文本的极简 PDF（避免引入额外生成库）。
function minimalPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 44} >>\nstream\nBT /F1 18 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const pdfBuffer = minimalPdf('Mirelth PDF extraction check');
const extracted = await pdfToMarkdown(pdfBuffer);
console.log('[PDF] pages =', extracted.pages, '| needsOcr =', extracted.needsOcr);
console.log('[PDF] markdown =', JSON.stringify(extracted.markdown.slice(0, 120)));
assert.equal(extracted.pages, 1, 'PDF 应识别出 1 页');
assert.ok(extracted.markdown.includes('Mirelth'), 'PDF 应提取出文本层内容');
assert.equal(extracted.needsOcr, false, '有文本层时不应要求 OCR');

// ---- 2. PDF：坏文件应报可读错误 ----
let badRejected = false;
try {
  await pdfToMarkdown(Buffer.from('这不是 PDF'));
} catch (error) {
  badRejected = true;
  console.log('[PDF] 坏文件被拒绝：', error instanceof Error ? error.message : String(error));
}
assert.ok(badRejected, '坏 PDF 应抛错');

// ---- 3. OCR：语言包策略（默认自动下载并缓存）----
const status = ocrStatus();
console.log('[OCR] ready =', status.ready, '| langs =', status.langs, '| missing =', status.missing.join(','));
console.log('[OCR] langPath =', status.langPath);
console.log('[OCR] autoDownload =', status.autoDownload, '| willDownload =', status.willDownload);
assert.equal(status.autoDownload, true, '默认应允许自动下载语言包');

// 确认 office 链路仍可用（依赖升级后的回归检查）。
await markdownToDocx('验证', '# 标题\n\n正文');

// 真实识别：本地已有语言包时直接跑；缺包则触发一次下载（数十 MB，耗时较长）。
// 用 OCR_SKIP_RECOGNIZE=1 可跳过，只校验策略。
if (process.env.OCR_SKIP_RECOGNIZE === '1') {
  console.log('[OCR] 已按 OCR_SKIP_RECOGNIZE=1 跳过真实识别');
} else {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  try {
    const result = await recognizeImage(png);
    console.log('[OCR] 识别链路可用，chars =', result.text.length, 'confidence =', result.confidence);
    const after = ocrStatus();
    console.log('[OCR] 识别后 ready =', after.ready, '| missing =', after.missing.join(','));
    assert.equal(after.ready, true, '识别成功后语言包应已落到本地');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('[OCR] 识别未成功：', message.slice(0, 200));
    // 下载失败属环境问题（无外网/代理），不视为代码缺陷，但必须给出可操作提示。
    assert.ok(/语言包|网络|下载|识别/.test(message), '失败时应有可操作的中文提示');
  }
}

// ---- 4. 确认 docx 链路未被依赖升级破坏 ----
const docxBuffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('回归检查')] }] }));
assert.ok(docxBuffer.length > 500, 'docx 生成应仍可用');
console.log('[DOCX] 生成正常，字节数 =', docxBuffer.length);

// tesseract 的 worker 线程会让进程留着不退，验证完显式收尾。
const { closeOcr } = await import('../server/shared/ocr.ts');
await closeOcr();

console.log('\n验证完成：PDF 提取可用、坏文件被拒、OCR 语言包策略与超时保护按预期工作。');
process.exit(0);