// 抖音浏览器拦截下载：不跟抖音签名硬碰，用真 Chrome 打开视频页，
// 从网络请求里捞出 *.douyinvod.com 的 CDN 直链，再带 Referer 下载到 imports/。
// 复用本机已装 Chrome（playwright-core，不下载内核）。yt-dlp 被抖音风控挡住时走这条路。

import { chromium } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPORTS_DIR = path.resolve(__dirname, "..", "data", "videos", "imports");

// 桌面版 Chrome 默认安装位置；可用环境变量 CHROME_PATH 覆盖。
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DOUYIN_HOSTS = /(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com)$/i;

export function isDouyinUrl(url) {
  try {
    return DOUYIN_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// 是否是视频 CDN 直链：路径含 /video/tos/、非音轨即可。
// 抖音视频 CDN 域名不固定（douyinvod.com / zjcdn.com / bytecdn 等都见过），所以按「路径特征」判断，不锁域名。
function isVideoCdn(u) {
  return /^https?:\/\//i.test(u) && /\/video\/tos\//i.test(u) && !/mime_type=audio/i.test(u);
}

function brOf(u) {
  const m = /[?&]br=(\d+)/.exec(u);
  return m ? Number(m[1]) : 0;
}

// 选最佳直链：优先「不带 range 参数」的（带 range 的只回片段，会下成 2-3MB 半截），再按码率高优先。
function pickBest(urls) {
  return [...urls].sort((a, b) => {
    const ra = /[?&]range=/i.test(a) ? 1 : 0;
    const rb = /[?&]range=/i.test(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return brOf(b) - brOf(a);
  })[0];
}

async function downloadToFile(url, dest, referer, timeoutMs = 10 * 60 * 1000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer, Accept: "*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`CDN 返回 HTTP ${res.status}`);
    ensureDir(path.dirname(dest));
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
  const size = fs.statSync(dest).size;
  if (size < 10240) {
    fs.rmSync(dest, { force: true });
    throw new Error("CDN 返回内容过小，疑似错误页而非视频");
  }
  return size;
}

// 主流程：输入抖音链接（短链/详情页/分享文案里抠出的链接均可），返回与 yt-dlp 通道同构的结果。
export async function downloadDouyinViaBrowser(rawUrl, opts = {}) {
  ensureDir(IMPORTS_DIR);
  const chromePath = opts.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME;

  const id = sha1(rawUrl).slice(0, 12);
  const dest = path.join(IMPORTS_DIR, `douyin-${id}.mp4`);
  const baseInfo = { url: rawUrl, id, extractor: "douyin", ext: "mp4" };

  if (!opts.force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { kind: "url", status: "exists", videoPath: dest, info: { ...baseInfo, webpageUrl: rawUrl } };
  }

  // 必须用 headful（真窗口）：headless 会被抖音在连接层直接掐断（ERR_CONNECTION_CLOSED）。
  // 用 --window-position 把窗口挪到屏幕外，做到「有头但不打扰」。
  const useExplicit = fs.existsSync(chromePath);
  const browser = await chromium.launch({
    headless: opts.headless === true,
    executablePath: useExplicit ? chromePath : undefined,
    channel: useExplicit ? undefined : "chrome", // 找不到固定路径时让 playwright 自己定位已装 Chrome
    args: [
      "--disable-blink-features=AutomationControlled",
      "--mute-audio",
      "--window-position=-32000,-32000",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    });
    const page = await context.newPage();

    const candidates = new Set();
    const collect = (u) => {
      if (u && isVideoCdn(u)) candidates.add(u);
    };
    page.on("request", (r) => collect(r.url()));
    page.on("response", (r) => collect(r.url()));

    try {
      await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: opts.navTimeoutMs || 30000 });
    } catch {
      // 导航超时也继续：CDN 请求可能在 domcontentloaded 前就发出了
    }

    // 等播放器发起视频请求；过几秒还没有就主动触发 <video> 播放。
    const captureMs = opts.captureMs || 20000;
    for (let waited = 0; candidates.size === 0 && waited < captureMs; waited += 1000) {
      await page.waitForTimeout(1000);
      if (waited === 4000) {
        try {
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v) {
              v.muted = true;
              const p = v.play();
              if (p && p.catch) p.catch(() => {});
            }
          });
        } catch {}
      }
    }

    // <video> 的 currentSrc 往往就是正在播放的直链——最可靠的一手来源，补进候选。
    try {
      const vsrc = await page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? (v.currentSrc || v.src || "") : "";
      });
      if (vsrc && isVideoCdn(vsrc)) candidates.add(vsrc);
    } catch {}

    let pageTitle = null;
    try {
      pageTitle = (await page.title()) || null;
    } catch {}

    if (candidates.size === 0) {
      throw new Error(
        "抖音视频未能截获播放地址：可能是私密/需登录的视频，或被风控拦截。" +
          "可改用「上传」方式——手动把视频下下来再上传本地文件解析。"
      );
    }

    const best = pickBest(candidates);
    const bytes = await downloadToFile(best, dest, "https://www.douyin.com/");

    return {
      kind: "url",
      status: "downloaded",
      videoPath: dest,
      info: {
        ...baseInfo,
        title: pageTitle ? pageTitle.replace(/\s*[-|].*抖音.*$/, "").trim() || pageTitle : null,
        webpageUrl: page.url(),
        bytes,
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
