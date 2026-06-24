import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importAndParseVideo } from "./lib/videoImport.js";
import { describeShots } from "./lib/vlm.js";
import { transcribeVideo, alignToShots } from "./lib/asr.js";
import { composeShotScript, composeStoryboard } from "./lib/storyboard.js";
import { runStep2 } from "./lib/step2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env.local") }); // vlm 要火山 key
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const COOKIES_DIR = path.join(DATA_DIR, "cookies");
const FRAMES_DIR = path.join(DATA_DIR, "frames");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const REFS_DIR = path.join(DATA_DIR, "refs");
const PUBLIC_DIR = path.join(__dirname, "public");
const DIST_DIR = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 3001);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// 启动即清空 cookies 目录：上次异常残留的 cookies.txt（含抖音登录态）不带进新进程（红线：用完即删）
fs.rmSync(COOKIES_DIR, { recursive: true, force: true });
fs.mkdirSync(COOKIES_DIR, { recursive: true });
fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(REFS_DIR, { recursive: true });

function safeName(name) {
  return String(name || "video")
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "video";
}

function numberParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseOptions(body = {}) {
  return {
    threshold: numberParam(body.threshold, 0.3, 0.01, 0.95),
    minShotDur: numberParam(body.minShotDur, 0.5, 0.1, 10),
    targetShots: body.shots ? numberParam(body.shots, 0, 1, 50) : null,
  };
}

// 解析后按需补充：画面描述(vlm) / 台词(asr) / 分镜脚本成稿。失败不抛错，单镜失败不拖垮整体。
async function enrichResult(result, body = {}) {
  const wantDescribe = body.describe === "1" || body.describe === true || body.describe === "true";
  const wantTranscribe = body.transcribe === "1" || body.transcribe === true || body.transcribe === "true";

  if (wantDescribe) {
    const byIdx = new Map((await describeShots(result.parsed.shots, {})).map((d) => [d.idx, d]));
    for (const s of result.parsed.shots) {
      const d = byIdx.get(s.idx);
      s.vlm = d ? { ok: d.ok, desc: d.desc, error: d.error } : null;
    }
  }
  if (wantTranscribe) {
    const tr = await transcribeVideo(result.imported.videoPath, {});
    result.transcript = tr.ok
      ? { ok: true, text: tr.text, language: tr.language, model: tr.model }
      : { ok: false, error: tr.error };
    if (tr.ok) {
      const byIdx = new Map(alignToShots(tr.segments, result.parsed.shots).map((a) => [a.idx, a]));
      for (const s of result.parsed.shots) s.dialogue = byIdx.get(s.idx)?.text || "";
    }
  }
  for (const s of result.parsed.shots) s.script = composeShotScript(s);
  result.storyboard = composeStoryboard(result);
  return result;
}

// 对外响应白名单：只放行该暴露的字段。故意丢弃本机绝对路径（videoPath/sourcePath/framesDir 全路径、
// shot.keyframe 绝对路径），videoPath 只回文件名——前端本就只用文件名（红线：不把本机信息泄露到响应）。
function publicResult(result) {
  return {
    imported: {
      kind: result.imported.kind,
      status: result.imported.status,
      videoPath: path.basename(result.imported.videoPath || ""),
      info: result.imported.info || null,
    },
    parsed: {
      meta: result.parsed.meta,
      cutCount: result.parsed.cutCount,
      shotCount: result.parsed.shotCount,
      shots: result.parsed.shots.map((shot) => ({
        idx: shot.idx,
        start: shot.start,
        end: shot.end,
        dur: shot.dur,
        keyframeRel: shot.keyframeRel,
        vlm: shot.vlm && shot.vlm.ok ? shot.vlm.desc : null,
        dialogue: shot.dialogue || "",
        script: shot.script || "",
      })),
    },
    storyboard: result.storyboard || "",
    transcript: result.transcript && result.transcript.ok ? { text: result.transcript.text } : null,
  };
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".mp4") || ".mp4";
    const base = safeName(path.basename(file.originalname || "upload", ext));
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
});

const cookieStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, COOKIES_DIR),
  filename: (_req, file, cb) => {
    const base = safeName(path.basename(file.originalname || "cookies", path.extname(file.originalname || "")));
    cb(null, `${Date.now()}-${base}.txt`);
  },
});

const cookieUpload = multer({
  storage: cookieStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Step2 产品参考图上传（用完即删，只作生图输入）
const refStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, REFS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".png") || ".png";
    const base = safeName(path.basename(file.originalname || "ref", ext));
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});
const refUpload = multer({ storage: refStorage, limits: { fileSize: 20 * 1024 * 1024 } });

function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (e) {
    console.warn("[cleanup] 删除临时文件失败:", filePath, e.message);
  }
}

const app = express();
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/frames", express.static(FRAMES_DIR));
app.use("/images", express.static(IMAGES_DIR));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: "precise-parse" });
});

app.post("/api/parse-url", async (req, res, next) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) {
      res.status(400).json({ error: "请填写视频链接" });
      return;
    }

    const result = await importAndParseVideo(url, {
      parse: parseOptions(req.body),
    });
    await enrichResult(result, req.body);
    res.json(publicResult(result));
  } catch (err) {
    next(err);
  }
});

app.post("/api/parse-url-with-cookies", cookieUpload.single("cookies"), async (req, res, next) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) {
      res.status(400).json({ error: "请填写视频链接" });
      return;
    }
    if (!req.file?.path) {
      res.status(400).json({ error: "请上传 cookies.txt" });
      return;
    }

    const result = await importAndParseVideo(url, {
      import: { cookiesPath: req.file.path },
      parse: parseOptions(req.body),
    });
    await enrichResult(result, req.body);
    res.json(publicResult(result));
  } catch (err) {
    next(err);
  } finally {
    removeFileQuietly(req.file?.path);
  }
});

app.post("/api/parse-upload", upload.single("video"), async (req, res, next) => {
  try {
    if (!req.file?.path) {
      res.status(400).json({ error: "请上传视频文件" });
      return;
    }

    const result = await importAndParseVideo(req.file.path, {
      parse: parseOptions(req.body),
    });
    await enrichResult(result, req.body);
    res.json(publicResult(result));
  } catch (err) {
    next(err);
  } finally {
    // 解析时已把视频复制进 imports/，multer 落在 uploads/ 的原件用完即删，避免双份堆积
    removeFileQuietly(req.file?.path);
  }
});

// Step2 复刻洗稿：吃上一步的分镜表(含画面描述/台词) + 产品参考图 + 洗稿要求 → 每镜出新图+新文案
app.post("/api/step2", refUpload.array("refs", 3), async (req, res, next) => {
  const refs = (req.files || []).map((f) => f.path);
  try {
    if (!refs.length) {
      res.status(400).json({ error: "请上传至少一张产品参考图" });
      return;
    }
    let payload = {};
    try {
      payload = JSON.parse(req.body?.payload || "{}");
    } catch {
      payload = {};
    }
    const shots = Array.isArray(payload.shots) ? payload.shots : [];
    if (!shots.length) {
      res.status(400).json({ error: "没有分镜数据：请先在上一步解析视频，并勾选「画面描述」" });
      return;
    }
    const result = { parsed: { shots, meta: payload.meta || {} } };
    const r = await runStep2(result, {
      product: payload.product,
      requirement: payload.requirement,
      refImages: refs,
      limit: payload.limit ? Number(payload.limit) : undefined,
    });
    res.json(r);
  } catch (err) {
    next(err);
  } finally {
    for (const p of refs) removeFileQuietly(p); // 产品图是临时输入，生图后即删
  }
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/frames/")) {
      next();
      return;
    }
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
} else if (fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/frames/")) {
      next();
      return;
    }
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });
}

app.use((err, req, res, _next) => {
  const raw = err instanceof Error ? err.message : String(err);
  let message = raw;
  if (/fresh cookies|cookies.*needed|login|登录|cookie/i.test(raw)) {
    message = req.path.includes("with-cookies")
      ? "cookies.txt 无效、过期，或没有包含 douyin.com 登录态。请重新登录抖音网页版后导出 cookies.txt，再上传重试。"
      : "平台需要登录态或 fresh cookies，当前无法直接从链接下载。请上传 cookies.txt，或切到“上传”把视频保存到本地后解析。";
  }
  // 原始 stderr 只留在本机终端日志，绝不进响应体——它可能含本机绝对路径 / cookies 临时文件路径（红线）
  console.error("[api:error]", raw);
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`[server] C200 precise parser listening on http://127.0.0.1:${PORT}`);
});
