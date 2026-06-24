import { chromium } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPORTS_DIR = path.resolve(__dirname, "..", "data", "videos", "imports");

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REFERER = "https://www.douyin.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const DOUYIN_HOSTS = /(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com)$/i;
const DOUYIN_VOD_HOST = /(^|\.)douyinvod\.com$/i;

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

function brOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return Number(u.searchParams.get("br") || u.searchParams.get("bt") || 0);
  } catch {
    return 0;
  }
}

function normalizeCdnUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Some player requests include a byte range query. Downloading that URL
    // directly can save only a fragment, so keep the signed URL but drop range.
    u.searchParams.delete("range");
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function isVideoCdn(rawUrl, headers = {}) {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return false;

    const mime = (u.searchParams.get("mime_type") || "").toLowerCase();
    const contentType = String(headers["content-type"] || headers.contentType || "").toLowerCase();
    if (mime.includes("audio") || contentType.includes("audio")) return false;

    const isVodHost = DOUYIN_VOD_HOST.test(u.hostname);
    const isVideoPath = /\/video\/tos\//i.test(u.pathname);
    const isMp4Param = mime === "video_mp4" || mime === "video/mp4";
    const isVideoResponse = contentType.includes("video/");

    return (isVodHost && isMp4Param) || (isVodHost && isVideoPath) || (isVideoPath && (isMp4Param || isVideoResponse));
  } catch {
    return false;
  }
}

function scoreCandidate(rawUrl, headers = {}) {
  try {
    const u = new URL(rawUrl);
    let score = brOf(rawUrl);
    if (DOUYIN_VOD_HOST.test(u.hostname)) score += 10000;
    if (/\/video\/tos\//i.test(u.pathname)) score += 5000;
    if ((u.searchParams.get("mime_type") || "").toLowerCase() === "video_mp4") score += 3000;
    if (!/[?&]range=/i.test(rawUrl)) score += 1000;
    if (String(headers["content-type"] || "").toLowerCase().includes("video/")) score += 500;
    return score;
  } catch {
    return 0;
  }
}

function sortedCandidates(candidates) {
  return [...candidates.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return brOf(b.url) - brOf(a.url);
  });
}

function parseBool(value) {
  if (value == null || value === "") return null;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function buildLaunchAttempts(opts = {}) {
  const chromePath = opts.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME;
  const explicitChrome = fs.existsSync(chromePath);
  const envHeadless = parseBool(process.env.DOUYIN_HEADLESS);
  const preferredHeadless = opts.headless ?? envHeadless ?? true;
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--mute-audio",
    "--window-position=-32000,-32000",
  ];

  const attempts = [];
  const add = (label, launch) => {
    const key = JSON.stringify({ label, launch });
    if (!attempts.some((a) => a.key === key)) attempts.push({ key, label, launch });
  };

  if (explicitChrome) {
    add(`system Chrome ${preferredHeadless ? "headless" : "headful"}`, {
      executablePath: chromePath,
      headless: preferredHeadless,
      args,
    });
    if (preferredHeadless) {
      add("system Chrome headful fallback", {
        executablePath: chromePath,
        headless: false,
        args,
      });
    }
  } else if (process.platform === "win32") {
    add(`Chrome channel ${preferredHeadless ? "headless" : "headful"}`, {
      channel: "chrome",
      headless: preferredHeadless,
      args,
    });
    if (preferredHeadless) {
      add("Chrome channel headful fallback", {
        channel: "chrome",
        headless: false,
        args,
      });
    }
  } else {
    add(`Playwright Chromium ${preferredHeadless ? "headless" : "headful"}`, {
      headless: preferredHeadless,
      args,
    });
  }

  return attempts;
}

async function triggerPlayback(page) {
  try {
    await page.mouse.click(640, 420);
  } catch {}

  try {
    await page.keyboard.press("Space");
  } catch {}

  try {
    await page.evaluate(() => {
      const clickTarget =
        document.querySelector(".xgplayer-start") ||
        document.querySelector(".xgplayer-play") ||
        document.querySelector("[class*=play]") ||
        document.querySelector("video");

      if (clickTarget && typeof clickTarget.click === "function") clickTarget.click();

      const video = document.querySelector("video");
      if (video) {
        video.muted = true;
        video.playsInline = true;
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }

      window.scrollBy(0, 160);
    });
  } catch {}
}

async function downloadToFile(url, dest, referer = REFERER, timeoutMs = 10 * 60 * 1000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const tmp = `${dest}.part`;
  fs.rmSync(tmp, { force: true });

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: referer,
        Origin: "https://www.douyin.com",
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) throw new Error(`CDN returned HTTP ${res.status}`);

    ensureDir(path.dirname(dest));
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));

    const size = fs.statSync(tmp).size;
    if (size < 64 * 1024) throw new Error("CDN response is too small; probably an error page or a video fragment");

    fs.renameSync(tmp, dest);
    return { bytes: size, contentType: res.headers.get("content-type") || null };
  } finally {
    clearTimeout(timer);
    fs.rmSync(tmp, { force: true });
  }
}

async function collectVideoCandidates(browser, rawUrl, opts = {}) {
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  const candidates = new Map();

  const collect = (url, source, headers = {}) => {
    const normalized = normalizeCdnUrl(url);
    if (!isVideoCdn(normalized, headers)) return;
    const old = candidates.get(normalized);
    const next = {
      url: normalized,
      source,
      headers,
      score: scoreCandidate(normalized, headers),
    };
    if (!old || next.score > old.score) candidates.set(normalized, next);
  };

  page.on("request", (request) => collect(request.url(), "request"));
  page.on("response", (response) => {
    const status = response.status();
    if (status !== 200 && status !== 206) return;
    collect(response.url(), "response", response.headers());
  });

  try {
    await page.goto(rawUrl, { waitUntil: opts.waitUntil || "commit", timeout: opts.navTimeoutMs || 15000 });
  } catch {
    // Douyin pages often keep long-polling resources open. Continue because the
    // video CDN request may already have been emitted before navigation timeout.
  }

  const captureMs = opts.captureMs || 18000;
  for (let waited = 0; waited < captureMs; waited += 1000) {
    await page.waitForTimeout(1000);

    if (waited === 1000 || waited === 4000 || waited === 9000) await triggerPlayback(page);

    if (candidates.size > 0 && waited >= 5000) break;
  }

  try {
    const pageUrls = await page.evaluate(() => {
      const video = document.querySelector("video");
      const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
      return [video?.currentSrc || "", video?.src || "", ...resources].filter(Boolean);
    });
    for (const url of pageUrls) collect(url, "page");
  } catch {}

  let pageTitle = null;
  try {
    pageTitle = (await page.title()) || null;
  } catch {}

  const webpageUrl = page.url();
  await context.close().catch(() => {});

  return { candidates: sortedCandidates(candidates), pageTitle, webpageUrl };
}

function cleanDouyinTitle(pageTitle) {
  if (!pageTitle) return null;
  return pageTitle.replace(/\s*[-|].*抖音.*$/, "").trim() || pageTitle;
}

async function captureAndDownload(rawUrl, dest, opts = {}) {
  let lastError = null;

  for (const attempt of buildLaunchAttempts(opts)) {
    let browser = null;
    try {
      browser = await chromium.launch(attempt.launch);
      const { candidates, pageTitle, webpageUrl } = await collectVideoCandidates(browser, rawUrl, opts);

      if (candidates.length === 0) {
        throw new Error("未截获 douyinvod 视频 CDN 地址");
      }

      for (const candidate of candidates) {
        try {
          const result = await downloadToFile(candidate.url, dest, REFERER, opts.downloadTimeoutMs || 10 * 60 * 1000);
          return {
            pageTitle,
            webpageUrl,
            bytes: result.bytes,
            contentType: result.contentType,
            cdnUrl: candidate.url,
            cdnSource: candidate.source,
            browserMode: attempt.label,
            br: brOf(candidate.url) || null,
            tried: candidates.length,
          };
        } catch (e) {
          lastError = e;
        }
      }

      throw lastError || new Error("候选 CDN 地址均下载失败");
    } catch (e) {
      lastError = e;
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  throw lastError || new Error("抖音视频下载失败");
}

export async function downloadDouyinViaBrowser(rawUrl, opts = {}) {
  ensureDir(IMPORTS_DIR);

  const id = sha1(rawUrl).slice(0, 12);
  const dest = path.join(IMPORTS_DIR, `douyin-${id}.mp4`);
  const baseInfo = { url: rawUrl, id, extractor: "douyin", ext: "mp4" };

  if (!opts.force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { kind: "url", status: "exists", videoPath: dest, info: { ...baseInfo, webpageUrl: rawUrl } };
  }

  try {
    const downloaded = await captureAndDownload(rawUrl, dest, opts);
    return {
      kind: "url",
      status: "downloaded",
      videoPath: dest,
      info: {
        ...baseInfo,
        title: cleanDouyinTitle(downloaded.pageTitle),
        webpageUrl: downloaded.webpageUrl,
        bytes: downloaded.bytes,
        br: downloaded.br,
        cdnSource: downloaded.cdnSource,
        browserMode: downloaded.browserMode,
        contentType: downloaded.contentType,
      },
    };
  } catch (e) {
    throw new Error(
      `抖音视频未能下载：${e.message || e}。可能是私密/需登录视频、当前 IP 被风控，或页面没有发出 video_mp4 CDN 请求；可先改用本地上传。`
    );
  }
}
