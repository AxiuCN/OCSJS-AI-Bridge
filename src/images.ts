/**
 * 图片准备：把题目里的图片变成可以交给上游的 data URL。
 *
 * 行为契约对齐现有 response_service：
 * - 浏览器提交的 data URL 先校验格式与大小
 * - 否则按超星图片的习惯请求头下载，并用魔术字节嗅探真实类型
 * - 单张图片失败只记 warning；一张都读不到且题目声明有图时，属于题目级错误，
 *   直接拒绝作答（不降级），避免"看不见图还硬猜"
 * - 并发下载有上限，避免一题几十张图打满连接
 */

import { Buffer } from "node:buffer";

import { ImagePreparationError, type Attachment, type NormalizedQuestion } from "./domain.js";

const IMAGE_DATA_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/iu;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const DOWNLOAD_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://p.ananas.chaoxing.com/",
};

export interface ImageLimits {
  imageTimeoutSeconds: number;
  maxImages: number;
  maxImageBytes: number;
  imageConcurrency: number;
  requireDeclaredImages: boolean;
}

export interface PreparedImage {
  label: string;
  dataUrl: string;
}

export interface ImagePreparationResult {
  images: PreparedImage[];
  warnings: string[];
}

export function sniffImageMime(content: Buffer): string {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return "image/jpeg";
  }
  if (content.length >= 6 && content.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/)) {
    return "image/gif";
  }
  if (content.length >= 12 && content.subarray(0, 4).toString("latin1") === "RIFF" && content.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (content.length >= 2 && content[0] === 0x42 && content[1] === 0x4d) {
    return "image/bmp";
  }
  return "";
}

function guessMimeFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? url;
  const extension = withoutQuery.slice(withoutQuery.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "";
}

/** 在后台执行任务，但最多同时运行 limit 个。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ImagePreparer {
  constructor(
    private readonly limits: ImageLimits,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private validateDataUrl(value: string): string {
    const trimmed = value.trim();
    const matched = IMAGE_DATA_PATTERN.exec(trimmed);
    if (!matched) throw new ImagePreparationError("浏览器提交的图片不是有效的 image data URL");
    let size: number;
    try {
      size = Buffer.from(matched[2]!, "base64").byteLength;
    } catch {
      throw new ImagePreparationError("浏览器提交的图片 Base64 无效");
    }
    if (size > this.limits.maxImageBytes) {
      throw new ImagePreparationError(`图片超过服务端大小限制（${size} bytes）`);
    }
    return trimmed;
  }

  private async downloadImage(url: string, signal: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.limits.imageTimeoutSeconds * 1000);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: DOWNLOAD_HEADERS, signal: combined, redirect: "follow" });
    } catch (error) {
      throw new ImagePreparationError(`服务端无法读取图片 ${url}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new ImagePreparationError(`服务端无法读取图片 ${url}: HTTP ${response.status}`);
    }

    // 先用 Content-Length 预判：远端图片可能远大于上限，
    // 若先整块读进内存再检查，一张超大图就能把服务打爆。
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > this.limits.maxImageBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImagePreparationError(`图片超过服务端大小限制（声明 ${contentLength} bytes）`);
    }

    const content = await this.readBodyWithLimit(response, url);
    const headerType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    let mime = headerType.startsWith("image/") ? headerType : "";
    if (!mime) mime = guessMimeFromUrl(url);
    if (!mime) mime = sniffImageMime(content);
    if (!mime.startsWith("image/")) {
      throw new ImagePreparationError(`远端内容不是图片：${mime || headerType || "unknown"}`);
    }
    return `data:${mime};base64,${content.toString("base64")}`;
  }

  /** 流式读取并即时计数：超过上限立刻中止，内存占用始终有界。 */
  private async readBodyWithLimit(response: Response, url: string): Promise<Buffer> {
    const limit = this.limits.maxImageBytes;
    const body = response.body;
    if (!body) {
      // 少数实现没有可读流，只能退回整块读取（此时 Content-Length 检查已先执行过）
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > limit) {
        throw new ImagePreparationError(`图片超过服务端大小限制（${buffer.byteLength} bytes）`);
      }
      return buffer;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > limit) {
          await body.cancel().catch(() => undefined);
          throw new ImagePreparationError(`图片超过服务端大小限制（已读取 ${total} bytes，上限 ${limit}）`);
        }
        chunks.push(buffer);
      }
    } catch (error) {
      if (error instanceof ImagePreparationError) throw error;
      throw new ImagePreparationError(`读取图片 ${url} 时连接中断：${(error as Error).message}`);
    }
    return Buffer.concat(chunks);
  }

  private async prepareOne(attachment: Attachment, signal: AbortSignal): Promise<PreparedImage> {
    const dataUrl = attachment.dataUrl
      ? this.validateDataUrl(attachment.dataUrl)
      : await this.downloadImage(attachment.sourceUrl, signal);
    return { label: attachment.label, dataUrl };
  }

  async prepare(question: NormalizedQuestion, signal: AbortSignal): Promise<ImagePreparationResult> {
    const selected = question.attachments.slice(0, this.limits.maxImages);
    const warnings: string[] = [];
    const images: PreparedImage[] = [];

    const settled = await mapWithConcurrency(selected, this.limits.imageConcurrency, async (attachment) => {
      try {
        return { ok: true as const, value: await this.prepareOne(attachment, signal) };
      } catch (error) {
        if (error instanceof ImagePreparationError) return { ok: false as const, error };
        throw error;
      }
    });

    settled.forEach((outcome, index) => {
      if (outcome.ok) {
        images.push(outcome.value);
        return;
      }
      const label = selected[index]?.label ?? `图片 ${index + 1}`;
      warnings.push(`${label}: ${outcome.error.message}`);
    });

    if (question.attachments.length > 0 && images.length === 0 && this.limits.requireDeclaredImages) {
      throw new ImagePreparationError(
        "题目包含图片，但服务端没有拿到任何可读图片。请安装 OCS 异步取图补丁，让浏览器提交 data URL。",
      );
    }

    return { images, warnings };
  }
}
