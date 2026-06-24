// C200 台词模块 —— 抽音轨 + 本地 whisper(faster-whisper) 离线听写，输出带时间戳的台词，
// 可按时间对齐到镜头表。不联网（模型首次下载后缓存在 ~/.cache/huggingface，转写全程离线）。
// 听写本体在 scripts/asr_whisper.py（faster-whisper），本模块负责抽音轨 + spawn + 解析。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const PY_SCRIPT = path.resolve(__dirname, "..", "scripts", "asr_whisper.py");

function run(cmd, args, opts = {}) {
  const { timeoutMs = 600000 } = opts;
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
        reject(new Error(`${cmd} 超时（${timeoutMs}ms）`));
        return;
      }
      resolve({ code, out, err });
    });
  });
}

// 抽 16k 单声道 wav（whisper 友好格式）。返回 wav 绝对路径。
export async function extractAudio(videoPath, opts = {}) {
  if (!fs.existsSync(videoPath)) throw new Error(`视频不存在: ${videoPath}`);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const base = path.basename(videoPath).replace(/\.[^.]+$/, "");
  const wav = path.join(AUDIO_DIR, `${base}.wav`);
  const { code, err } = await run(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
    { timeoutMs: opts.ffmpegTimeoutMs || 120000 }
  );
  if (code !== 0 || !fs.existsSync(wav)) {
    throw new Error(`抽音轨失败（ffmpeg exit ${code}）：${String(err).slice(-200).trim()}`);
  }
  return wav;
}

// 调本地 whisper 听写一个音频文件 → { ok, text, segments:[{start,end,text}], language, model, ... }
// 失败不抛错，返回 { ok:false, error }。
export async function transcribeAudio(audioPath, opts = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) return { ok: false, error: `音频不存在: ${audioPath}` };
  const py = opts.python || process.env.ASR_PYTHON || "python";
  const model = opts.model || process.env.ASR_MODEL || "small";
  const lang = opts.lang || process.env.ASR_LANG || "zh";
  let res;
  try {
    res = await run(py, [PY_SCRIPT, audioPath, "--model", model, "--lang", lang], { timeoutMs: opts.timeoutMs || 600000 });
  } catch (e) {
    return { ok: false, error: `调用 whisper 失败（${py} 不可用？）: ${e.message}` };
  }
  // python 只往 stdout 打一行 JSON；告警走 stderr。取最后一个非空行解析。
  const line = String(res.out).trim().split(/\r?\n/).filter(Boolean).pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: "whisper 返回的不是合法 JSON", raw: line.slice(0, 300), stderr: String(res.err).slice(-300) };
  }
}

// 视频 → 台词（抽音轨 + 听写一条龙）
export async function transcribeVideo(videoPath, opts = {}) {
  const wav = await extractAudio(videoPath, opts);
  return transcribeAudio(wav, opts);
}

// 把台词段按时间对齐到镜头：以台词段中点归属唯一镜头，避免跨界重复。
// 返回 [{ idx, lines:[...], text }]，与 shots 一一对应。
export function alignToShots(segments, shots) {
  const segs = segments || [];
  return (shots || []).map((shot) => {
    const lines = segs
      .filter((s) => {
        const mid = (s.start + s.end) / 2;
        return mid >= shot.start && mid < shot.end;
      })
      .map((s) => s.text);
    return { idx: shot.idx, lines, text: lines.join("") };
  });
}
