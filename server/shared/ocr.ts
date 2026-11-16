/**
 * OCR：tesseract.js（WebAssembly），Node 侧运行。
 *
 * 语言包策略：**首次自动下载并缓存到本地**，之后复用本地文件。
 * 用户不需要手动准备 .traineddata。若把 OCR_AUTO_DOWNLOAD 设为 false，
 * 则退回「只用本地包、缺包报错」的严格模式（适合内网/无外网环境）。
 *
 * 核心 wasm 在 Node 侧是本地 require（tesseract.js-core），本身不触网；
 * 唯一的外部请求是语言包下载，只在本地缺包且允许自动下载时发生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { BadRequestError } from './errors.ts';
import { logger } from './logger.ts';

export interface OcrResult { text: string; confidence: number; langs: string }

function langDir(): string {
  return path.resolve(config.root, config.ocr.langPath);
}

function langList(): string[] {
  return config.ocr.langs.split('+').map((item) => item.trim()).filter(Boolean);
}

/** 本地是否已有该语言包（.traineddata 或 .traineddata.gz 皆可）。 */
function hasLocal(dir: string, lang: string): boolean {
  return fs.existsSync(path.join(dir, `${lang}.traineddata`))
    || fs.existsSync(path.join(dir, `${lang}.traineddata.gz`));
}

export interface OcrStatus {
  ready: boolean;
  langs: string;
  missing: string[];
  langPath: string;
  autoDownload: boolean;
  /** 缺包但允许自动下载：首次识别会联网取包，之后走本地缓存。 */
  willDownload: boolean;
}

export function ocrStatus(): OcrStatus {
  const dir = langDir();
  const missing = langList().filter((lang) => !hasLocal(dir, lang));
  const autoDownload = config.ocr.autoDownload;
  return {
    ready: missing.length === 0,
    langs: config.ocr.langs,
    missing,
    langPath: dir,
    autoDownload,
    willDownload: missing.length > 0 && autoDownload,
  };
}

let workerPromise: Promise<import('tesseract.js').Worker> | null = null;

/**
 * 已创建但可能仍在初始化的 worker 实例。
 * 必须单独持有：超时时 createWorker 的 promise 可能永不落定，
 * 只靠 `.then(w => w.terminate())` 清不掉——线程会泄漏并吊住整个进程。
 */
const pendingWorkers = new Set<import('tesseract.js').Worker>();

/**
 * 终止残留实例，**有界等待**。
 * worker.terminate() 自身是同步的，但初始化中失败时底层下载 socket 可能仍在重试，
 * 无界 await 会把退出流程一起拖住。这里最多等 2 秒就放手。
 */
async function terminatePending(): Promise<void> {
  const workers = [...pendingWorkers];
  pendingWorkers.clear();
  if (!workers.length) return;
  const cleanup = Promise.all(workers.map(async (worker) => {
    try { await worker.terminate(); } catch { /* 已退出或不可用 */ }
  }));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getWorker(): Promise<import('tesseract.js').Worker> {
  if (workerPromise) return workerPromise;
  const status = ocrStatus();

  if (!status.ready && !status.autoDownload) {
    throw new BadRequestError(
      `OCR 语言包缺失：${status.missing.join('、')}。请把对应的 .traineddata 放到 ${status.langPath}，`
      + '或将 OCR_AUTO_DOWNLOAD 设为 true 允许自动下载',
    );
  }

  workerPromise = (async () => {
    const { createWorker } = await import('tesseract.js');
    fs.mkdirSync(status.langPath, { recursive: true });

    if (status.willDownload) {
      logger.info('ocr.lang_download_started', { langs: status.missing.join(','), dir: status.langPath });
    }

    // errorHandler 必须传：tesseract.js 在缺省时会直接 `throw`（createWorker.js:217），
    // 错误从 worker 消息回调里抛出、逃过 await 的 try/catch，会把整个服务进程带崩。
    // 传一个空处理器让它只走 reject 路径，由下面的 catch 转成 BadRequestError。
    const shared = {
      logger: () => { /* 进度日志太吵 */ },
      errorHandler: (error: unknown) => {
        logger.warn('ocr.worker_error', { error: error instanceof Error ? error.message : String(error) });
      },
    };

    // 本地包齐备 → 只读本地（langPath 指向目录 + cacheMethod 'none'）。
    // 缺包且允许下载 → 用默认 CDN 取包，cacheMethod 'write' 落到本地，下次不再联网。
    const options = status.ready
      ? {
        ...shared,
        langPath: status.langPath,
        cachePath: status.langPath,
        cacheMethod: 'none' as const,
        gzip: hasGzip(status.langPath),
      }
      : {
        ...shared,
        cachePath: status.langPath,
        cacheMethod: 'write' as const,
        gzip: true,
      };

    // 下载语言包比本地加载慢得多，给更长的时限；两者都必须有上限。
    const limit = status.ready ? config.ocr.initTimeoutMs : config.ocr.downloadTimeoutMs;
    const label = status.ready ? 'OCR 初始化' : 'OCR 语言包下载';

    const creating = createWorker(config.ocr.langs, 1, options);
    // 拿到实例就登记，即使它一直不 resolve 也能在超时/失败时被终止。
    void creating.then((worker) => { pendingWorkers.add(worker); }).catch(() => { /* 失败走下面的清理 */ });

    let timer: NodeJS.Timeout | undefined;
    try {
      const worker = await Promise.race([
        creating,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(limit / 1000)}秒）`)), limit);
        }),
      ]);
      pendingWorkers.delete(worker);
      if (status.willDownload) logger.info('ocr.lang_download_done', { langs: config.ocr.langs });
      return worker;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  try {
    return await workerPromise;
  } catch (error) {
    // 失败后清空缓存并终止所有残留实例，否则后续请求复用坏实例、线程也会吊住进程。
    workerPromise = null;
    await terminatePending();

    const detail = error instanceof Error ? error.message : String(error);
    if (/网络|下载|network|fetch|ENOTFOUND|ECONNREFUSED|超时|timeout|Response code/i.test(detail)) {
      throw new BadRequestError(
        `OCR 语言包获取失败（${detail.slice(0, 120)}）。请检查网络，或手动把 .traineddata 放到 ${status.langPath}`,
      );
    }
    throw new BadRequestError(`OCR 初始化失败：${detail.slice(0, 160)}`);
  }
}

function hasGzip(dir: string): boolean {
  const first = langList()[0];
  return Boolean(first) && fs.existsSync(path.join(dir, `${first}.traineddata.gz`));
}

/** 识别一张图片。支持 png/jpg/bmp 等 tesseract 可直接解码的格式。 */
export async function recognizeImage(buffer: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  try {
    const { data } = await worker.recognize(buffer);
    const text = (data.text ?? '').trim();
    logger.info('ocr.recognized', { chars: text.length, confidence: data.confidence });
    return { text, confidence: Math.round(data.confidence ?? 0), langs: config.ocr.langs };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BadRequestError(`识别失败：${detail.slice(0, 160)}`);
  }
}

export async function closeOcr(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  if (current) {
    try {
      const worker = await current;
      pendingWorkers.delete(worker);
      await worker.terminate();
    } catch { /* 初始化本就失败，交给下面的兜底清理 */ }
  }
  await terminatePending();
}