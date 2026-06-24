// 精解析导入层：把 URL 或本地视频统一落到 data/videos/imports/，再交给 ffmpeg 解析。
// URL 下载走 yt-dlp；本地文件走 copy，不在原始文件上操作。

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVideo } from "./videoParse.js";
import { isDouyinUrl, downloadDouyinViaBrowser } from "./douyinBrowser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const VIDEOS_DIR = path.join(DATA_DIR, "videos");
const IMPORTS_DIR = path.join(VIDEOS_DIR, "imports");
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function isHttpUrl(input) {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 从一段文本里抠出第一个 http(s) 链接（抖音/小红书分享文案常把链接夹在中文里）。
// 字符类排除空白、引号、尖括号、CJK 标点与 CJK 汉字——真实链接里不会出现这些，
// 所以"全角括号包裹链接"或"中文紧贴链接没空格"都能干净切开。
// 注意：public/app.js 有一份逐字相同的实现，改这里必须同步改那边。
export function extractFirstHttpUrl(input) {
  const match = String(input || "").match(/https?:\/\/[^\s"'<>，。；、！？（）【】《》「」…一-鿿]+/i);
  return match ? match[0].replace(/[)\]，。、；！？.,]+$/g, "") : null;
}

function safeSlug(input, fallback = "video") {
  const cleaned = String(input || "")
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(cmd, args, opts = {}) {
  const { timeoutMs = 120000 } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGTERM");
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, out, err });
    });
  });
}

function summarizeInfo(info, url) {
  return {
    url,
    id: info.id || null,
    title: info.title || null,
    extractor: info.extractor || info.extractor_key || null,
    duration: typeof info.duration === "number" ? info.duration : null,
    webpageUrl: info.webpage_url || info.original_url || url,
    thumbnail: info.thumbnail || null,
    ext: info.ext || null,
  };
}

export async function getVideoInfo(url, opts = {}) {
  if (!isHttpUrl(url)) throw new Error(`不是有效的 http(s) 链接: ${url}`);

  const args = [
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    String(opts.socketTimeoutSec || 20),
  ];
  if (opts.cookiesPath) args.push("--cookies", opts.cookiesPath);
  args.push(url);

  const { code, out, err } = await run("yt-dlp", args, { timeoutMs: opts.timeoutMs || 60000 });
  if (code !== 0) {
    throw new Error(`yt-dlp 读取链接信息失败: ${err.trim() || out.trim() || `exit ${code}`}`);
  }

  let info;
  try {
    info = JSON.parse(out);
  } catch {
    throw new Error("yt-dlp 返回的不是合法 JSON（链接可能需要登录或被反爬拦截）");
  }
  if (!info || typeof info !== "object") {
    throw new Error("yt-dlp 未解析出视频信息（链接可能无效或需要登录）");
  }
  return summarizeInfo(info, url);
}

function findDownloadedVideo(outDir, prefix) {
  const files = fs
    .readdirSync(outDir)
    .filter((name) => name.startsWith(prefix + "."))
    .filter((name) => VIDEO_EXTS.has(path.extname(name).toLowerCase()))
    .map((name) => {
      const abs = path.join(outDir, name);
      return { abs, size: fs.statSync(abs).size };
    })
    .filter((f) => f.size > 0)
    .sort((a, b) => b.size - a.size);

  return files[0]?.abs || null;
}

export async function downloadVideoFromUrl(url, opts = {}) {
  const info = await getVideoInfo(url, opts);
  ensureDir(IMPORTS_DIR);

  const id = sha1(url).slice(0, 12);
  const slug = safeSlug(info.title || info.id || new URL(url).hostname);
  const prefix = `${slug}-${id}`;
  const existing = findDownloadedVideo(IMPORTS_DIR, prefix);
  if (existing && !opts.force) {
    return { kind: "url", status: "exists", videoPath: existing, info };
  }

  const outputTemplate = path.join(IMPORTS_DIR, `${prefix}.%(ext)s`);
  const args = [
    "--no-playlist",
    "--windows-filenames",
    "--merge-output-format",
    "mp4",
    "-f",
    opts.format || "bv*+ba/best[ext=mp4]/best",
    "-o",
    outputTemplate,
  ];
  if (opts.cookiesPath) args.push("--cookies", opts.cookiesPath);
  args.push(url);

  const { code, out, err } = await run("yt-dlp", args, { timeoutMs: opts.downloadTimeoutMs || 10 * 60 * 1000 });
  if (code !== 0) {
    throw new Error(`yt-dlp 下载失败: ${err.trim() || out.trim() || `exit ${code}`}`);
  }

  const videoPath = findDownloadedVideo(IMPORTS_DIR, prefix);
  if (!videoPath) throw new Error(`yt-dlp 下载结束，但未找到输出视频: ${outputTemplate}`);

  return { kind: "url", status: "downloaded", videoPath, info };
}

export function importLocalVideo(sourcePath, opts = {}) {
  const abs = path.resolve(sourcePath);
  if (!fs.existsSync(abs)) throw new Error(`视频文件不存在: ${sourcePath}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`不是文件: ${sourcePath}`);

  const ext = path.extname(abs).toLowerCase();
  if (!VIDEO_EXTS.has(ext) && !opts.allowUnknownExt) {
    throw new Error(`不支持的视频后缀 ${ext || "(无后缀)"}，支持: ${[...VIDEO_EXTS].join(", ")}`);
  }

  ensureDir(IMPORTS_DIR);
  const base = safeSlug(path.basename(abs, ext));
  const id = sha1(`${abs}:${stat.size}:${stat.mtimeMs}`).slice(0, 12);
  const dest = path.join(IMPORTS_DIR, `${base}-${id}${ext || ".mp4"}`);

  if (abs === dest) return { kind: "local", status: "exists", sourcePath: abs, videoPath: dest };
  if (!fs.existsSync(dest) || opts.force) fs.copyFileSync(abs, dest);
  return { kind: "local", status: fs.existsSync(dest) ? "imported" : "missing", sourcePath: abs, videoPath: dest };
}

export async function importVideo(input, opts = {}) {
  const extractedUrl = extractFirstHttpUrl(input);
  if (extractedUrl && isHttpUrl(extractedUrl)) {
    // 抖音走浏览器拦截（yt-dlp 对抖音常被风控挡住）；其它平台继续走 yt-dlp。
    if (isDouyinUrl(extractedUrl)) return downloadDouyinViaBrowser(extractedUrl, opts);
    return downloadVideoFromUrl(extractedUrl, opts);
  }
  return importLocalVideo(input, opts);
}

export async function importAndParseVideo(input, opts = {}) {
  const imported = await importVideo(input, opts.import || {});
  const parsed = await parseVideo(imported.videoPath, opts.parse || {});
  return { imported, parsed };
}
