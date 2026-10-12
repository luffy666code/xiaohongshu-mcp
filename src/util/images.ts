import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { imagesDir } from "../config.js";
import { log } from "../log.js";

/** 按扩展名猜一个 Content-Type 兜底，站点可能不返回。 */
function extOf(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  const ext = path.extname(clean).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"].includes(ext) ? ext : ".jpg";
}

async function download(url: string): Promise<string> {
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });

  const name = `${crypto.createHash("sha1").update(url).digest("hex").slice(0, 16)}${extOf(url)}`;
  const target = path.join(dir, name);

  if (fs.existsSync(target)) {
    log.debug(`图片已缓存: ${target}`);
    return target;
  }

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载图片失败: ${url} (HTTP ${res.status})`);

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  log.info(`图片已下载: ${url} -> ${target}`);

  return target;
}

/**
 * 归一化图片输入：网络地址先下载到本地，本地路径原样返回。
 *
 * 浏览器只能上传本地文件，所以 URL 必须先落盘。
 */
export async function processImages(inputs: string[]): Promise<string[]> {
  const out: string[] = [];

  for (const item of inputs) {
    const trimmed = (item ?? "").trim();
    if (!trimmed) continue;

    if (/^https?:\/\//i.test(trimmed)) {
      out.push(await download(trimmed));
      continue;
    }
    out.push(trimmed);
  }

  return out;
}
