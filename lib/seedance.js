// C200 Step3 图生视频 —— 火山 Seedance：一张图(分镜复刻图) + 提示词 → 一段短视频。
// 异步任务流：创建 task → 轮询到 succeeded → 下载 video_url 到 data/clips/。
// 复用 IMAGE_API_KEY（可用 VIDEO_API_KEY/VIDEO_MODEL 覆盖）。每次生成都按 token 计费——只在用户手动点时调。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.resolve(__dirname, "..", "data", "clips");
const DEFAULT_MODEL = "doubao-seedance-1-0-pro-250528"; // 已验证此账号可用
const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3";

function arkBase() {
  return process.env.VIDEO_API_URL || process.env.IMAGE_API_URL || ARK_URL;
}
// 视频生成单独用 VIDEO_API_KEY（按次计费，故意不复用 IMAGE_API_KEY）。留空=不启用视频生成。
function arkKey() {
  return process.env.VIDEO_API_KEY || "";
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function imageToDataUrl(absPath) {
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// 创建视频生成任务，返回 taskId。Seedance 把参数写在 text 里（--ratio/--duration/--resolution）。
async function createTask({ imagePath, prompt, ratio, duration, resolution, model }) {
  const text =
    `${(prompt || "让画面自然地动起来，保持产品主体清晰稳定").trim()}` +
    ` --ratio ${ratio || "adaptive"} --duration ${duration || 5} --resolution ${resolution || "720p"}`;
  const content = [{ type: "text", text }];
  if (imagePath) {
    if (!fs.existsSync(imagePath)) throw new Error(`参考图不存在: ${imagePath}`);
    content.push({ type: "image_url", image_url: { url: imageToDataUrl(imagePath) } });
  }
  const res = await fetch(`${arkBase()}/contents/generations/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${arkKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: model || process.env.VIDEO_MODEL || DEFAULT_MODEL, content }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id) {
    throw new Error(`创建视频任务失败 HTTP ${res.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  }
  return j.id;
}

// 轮询任务直到出结果
async function pollTask(taskId, { timeoutMs = 8 * 60 * 1000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${arkBase()}/contents/generations/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${arkKey()}` },
    });
    const j = await res.json().catch(() => ({}));
    if (j.status === "succeeded") return j;
    if (j.status === "failed") throw new Error(`视频生成失败: ${JSON.stringify(j.error || j).slice(0, 200)}`);
    await sleep(intervalMs);
  }
  throw new Error(`视频生成超时（${Math.round(timeoutMs / 1000)}s）`);
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载视频失败 HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  if (size < 10240) {
    fs.rmSync(dest, { force: true });
    throw new Error("下载的视频过小，疑似失败");
  }
  return size;
}

// 主入口：一张图 → 一段视频。失败不抛错，返回 { ok:false, error }。
export async function generateClip(opts = {}) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const startMs = Date.now();
  const key = arkKey();
  if (!key || key.startsWith("<")) {
    return {
      ok: false,
      error: "视频生成暂未配置：请在 .env.local 填入 VIDEO_API_KEY（火山视频生成 key）后再用",
      durationMs: 0,
    };
  }
  try {
    let taskId;
    try {
      taskId = await createTask(opts);
    } catch (e) {
      throw new Error(`创建任务失败: ${e.message}`);
    }
    let task;
    try {
      task = await pollTask(taskId, { timeoutMs: opts.timeoutMs });
    } catch (e) {
      throw new Error(`等待生成失败: ${e.message}`);
    }
    const videoUrl = task && task.content && task.content.video_url;
    if (!videoUrl) throw new Error("任务成功但未返回 video_url");
    const tag = opts.idx ? `${String(opts.idx).padStart(2, "0")}-` : "";
    const name = `clip-${tag}${crypto.randomBytes(5).toString("hex")}.mp4`;
    const dest = path.join(CLIPS_DIR, name);
    let bytes;
    try {
      bytes = await downloadTo(videoUrl, dest);
    } catch (e) {
      throw new Error(`下载片段失败: ${e.message}`);
    }
    return {
      ok: true,
      taskId,
      clipPath: dest,
      clipRel: `/clips/${name}`,
      bytes,
      model: task.model,
      resolution: task.resolution,
      duration: task.duration,
      durationMs: Date.now() - startMs,
    };
  } catch (e) {
    return { ok: false, error: e.message, durationMs: Date.now() - startMs };
  }
}
