/**
 * 一次性验证脚本：PDF 文本提取、扫描件渲染、多模态识别链路。
 * 用 `node scripts/verify-pdf-ocr.ts` 运行；不进 npm test（真实识别需要模型密钥与网络）。
 *
 * 配了 LLM_API_KEY 时会真的调模型识别一张带文字的图片；
 * 未配密钥时只验证「渲染可用 + 未配模型时报错可操作」。
 */
process.env.DATABASE_PATH = '.data/verify-vision.db';
process.env.APP_SECRET = 'verify-vision-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';

import assert from 'node:assert/strict';

const { pdfToMarkdown, renderPdfPages } = await import('../server/shared/pdf.ts');
const { visionTranscribe, visionModelName } = await import('../server/ai/provider.ts');
const { config } = await import('../server/shared/config.ts');
const { createCanvas } = await import('@napi-rs/canvas');

/** 构造一个含文本的极简 PDF，避免引入额外生成库。 */
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

// ---- 1. 有文本层的 PDF：直接提取，不该走模型 ----
const extracted = await pdfToMarkdown(minimalPdf('Mirelth PDF extraction check'));
console.log('[PDF] pages =', extracted.pages, '| needsVision =', extracted.needsOcr);
assert.equal(extracted.pages, 1);
assert.ok(extracted.markdown.includes('Mirelth'), '应提取出文本层内容');
assert.equal(extracted.needsOcr, false, '有文本层时不该触发模型识别');

// ---- 2. 坏 PDF 应报可读错误 ----
let rejected = false;
try {
  await pdfToMarkdown(Buffer.from('这不是 PDF'));
} catch (error) {
  rejected = true;
  console.log('[PDF] 坏文件被拒绝：', error instanceof Error ? error.message : String(error));
}
assert.ok(rejected, '坏 PDF 应抛错');

// ---- 3. 扫描件链路的基础：逐页渲染为 PNG ----
const rendered = await renderPdfPages(minimalPdf('Scan render check'), 3);
console.log('[RENDER] pages =', rendered.length, '| mime =', rendered[0].mime);
const png = Buffer.from(rendered[0].base64, 'base64');
assert.equal(png[0], 0x89, '渲染结果应是合法 PNG');
assert.ok(png.length > 500, '渲染结果不应是空图');
console.log('[RENDER] png bytes =', png.length);

// ---- 4. 多模态识别 ----
console.log('[VISION] model =', visionModelName() || '(未配置)');
console.log('[VISION] maxPages =', config.vision.maxPages, '| scale =', config.vision.scale);

// 画一张带中文与英文文字的图片，作为真实识别样本。
const canvas = createCanvas(700, 240);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, 700, 240);
ctx.fillStyle = '#000000';
ctx.font = '32px sans-serif';
ctx.fillText('Invoice No: A-20261116', 30, 60);
ctx.font = '28px sans-serif';
ctx.fillText('Total: 1280.50', 30, 120);
ctx.fillText('Date: 2026-11-16', 30, 180);
const sample = { base64: canvas.toBuffer('image/png').toString('base64'), mime: 'image/png' };

if (!config.llm.enabled) {
  let guarded = false;
  try {
    await visionTranscribe([sample]);
  } catch (error) {
    guarded = true;
    const message = error instanceof Error ? error.message : String(error);
    console.log('[VISION] 未配模型时的提示：', message.slice(0, 160));
    assert.ok(/多模态|LLM_API_KEY|LLM_VISION_MODEL/.test(message), '提示应指向配置多模态模型');
  }
  assert.ok(guarded, '未配模型时必须明确报错，不能静默返回空');
  console.log('\n验证完成：文本提取、坏文件拒绝、扫描件渲染均正常；未配模型时报错可操作。');
  console.log('要验证真实识别质量，请配置 LLM_API_KEY 与 LLM_VISION_MODEL 后重跑本脚本。');
} else {
  const result = await visionTranscribe([sample], '这是一张票据截图，请转录其中的编号、金额与日期。');
  console.log('[VISION] 识别结果：\n', result.text);
  assert.ok(result.text.length > 0, '应返回识别文本');
  // 关键数字应被转录出来——这是判断识别是否真的可用的最低标准。
  const hitNumber = /1280/.test(result.text);
  const hitInvoice = /A-?20261116/i.test(result.text);
  console.log('[VISION] 金额命中 =', hitNumber, '| 编号命中 =', hitInvoice);
  assert.ok(hitNumber || hitInvoice, '至少应转录出一个关键字段，否则识别不可用');
  console.log('\n验证完成：多模态识别链路真实可用。');
}