// 冒烟测试：验证"视频 → 抽音轨 → 本地 whisper 听写 → 台词"整条通路。
// 跑法：npm run smoke:asr                       （默认拿 data/videos/imports 里第一个视频）
//      npm run smoke:asr -- <视频或音频路径>
//      ASR_MODEL=medium npm run smoke:asr        （换更准的模型）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeVideo, transcribeAudio } from "../lib/asr.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pickInput() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (arg) return path.resolve(arg);
  const importsDir = path.join(__dirname, "..", "data", "videos", "imports");
  if (fs.existsSync(importsDir)) {
    const vid = fs.readdirSync(importsDir).find((f) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(f) && !f.startsWith("_synth"));
    if (vid) return path.join(importsDir, vid);
  }
  return null;
}

const input = pickInput();
if (!input || !fs.existsSync(input)) {
  console.error("[smoke-asr] 找不到可用视频/音频。先 npm run parse:input 导入一个真实视频，或传一个路径。");
  process.exit(2);
}

const isAudio = /\.(wav|mp3|m4a|flac|ogg)$/i.test(input);
console.log("[smoke-asr] 输入:", input, isAudio ? "(音频)" : "(视频，先抽音轨)");
console.log("[smoke-asr] 模型:", process.env.ASR_MODEL || "small", "听写中（首次会下模型）...");

const t0 = Date.now();
const r = isAudio ? await transcribeAudio(input) : await transcribeVideo(input);
console.log(`[smoke-asr] 耗时 ${Date.now() - t0}ms  ok=${r.ok}`);

if (!r.ok) {
  console.error("[smoke-asr] ❌ 失败：", r.error);
  if (r.stderr) console.error("[smoke-asr] stderr:", r.stderr);
  process.exit(1);
}

console.log(`[smoke-asr] 语言=${r.language}(${r.languageProb}) 时长=${r.duration}s 模型=${r.model}`);
console.log("[smoke-asr] 全文台词：");
console.log("  " + r.text);
console.log("[smoke-asr] 分段：");
for (const s of r.segments) console.log(`  [${s.start}s-${s.end}s] ${s.text}`);

const ok = typeof r.text === "string" && r.text.length > 0;
console.log(ok ? "[smoke-asr] 🟢 台词听写通路正常" : "[smoke-asr] ❌ 没听出台词，需检查");
process.exit(ok ? 0 : 1);
