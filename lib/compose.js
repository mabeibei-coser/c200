// C200 Step4 视频合成 —— ffmpeg 把各段视频统一分辨率后按顺序拼成一条成片。
// 各段可能尺寸/编码不一致，所以统一 scale+pad 到目标尺寸再 concat（重编码，稳）。无音轨（i2v 产物本就静音）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINALS_DIR = path.resolve(__dirname, "..", "data", "finals");

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, err: e.message }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

async function probeDims(clipPath) {
  const { out } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    clipPath,
  ]);
  try {
    const j = JSON.parse(out || "{}");
    const s = (j.streams && j.streams[0]) || {};
    return { width: s.width || 0, height: s.height || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

// 把若干段视频拼成成片。clipPaths=按顺序的本机视频路径。返回 { ok, finalPath, finalRel } 或 { ok:false, error }。
export async function composeClips(clipPaths, opts = {}) {
  const clips = (clipPaths || []).filter((p) => p && fs.existsSync(p));
  if (clips.length === 0) return { ok: false, error: "没有可合成的视频片段" };
  fs.mkdirSync(FINALS_DIR, { recursive: true });

  // 目标尺寸：优先 opts，否则取第一段尺寸（h264 要偶数）
  let width = opts.width;
  let height = opts.height;
  if (!width || !height) {
    const d = await probeDims(clips[0]);
    width = d.width || 720;
    height = d.height || 1280;
  }
  width -= width % 2;
  height -= height % 2;

  const inputs = [];
  const filters = [];
  clips.forEach((c, i) => {
    inputs.push("-i", c);
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`
    );
  });
  const concat = clips.map((_, i) => `[v${i}]`).join("") + `concat=n=${clips.length}:v=1:a=0[outv]`;
  const filterComplex = `${filters.join(";")};${concat}`;

  const name = opts.name || `final-${clips.length}shots.mp4`;
  const dest = path.join(FINALS_DIR, name);
  const args = [...inputs, "-filter_complex", filterComplex, "-map", "[outv]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", dest];

  const { code, err } = await run("ffmpeg", args);
  if (code !== 0 || !fs.existsSync(dest)) {
    return { ok: false, error: `合成失败（ffmpeg exit ${code}）：${String(err).slice(-300).trim()}` };
  }
  return { ok: true, finalPath: dest, finalRel: `/finals/${name}`, width, height, clips: clips.length };
}
