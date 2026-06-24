// 手工入口：URL 或本地视频 -> 导入本地 -> 精解析镜头表。
// 用法：npm run parse:input -- "https://..." 或 npm run parse:input -- data/videos/demo.mp4

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importAndParseVideo } from "../lib/videoImport.js";
import { describeShots } from "../lib/vlm.js";
import { transcribeVideo, alignToShots } from "../lib/asr.js";
import { composeShotScript, composeStoryboard } from "../lib/storyboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });
const RESULTS_DIR = path.resolve(__dirname, "..", "data", "parse-results");

function readArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = hit.slice(name.length + 3);
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const input = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!input) {
  console.error('用法: npm run parse:input -- "<视频链接或本地视频路径>" [--shots=N] [--threshold=0.3] [--minShotDur=0.5] [--describe] [--transcribe]');
  process.exit(1);
}

const threshold = readArg("threshold", 0.3);
const minShotDur = readArg("minShotDur", 0.5);
const shots = readArg("shots", 0); // 加 --shots=N 则强制切成 N 个分镜（否则按阈值自动切）
const targetShots = shots >= 1 ? Math.floor(shots) : null;
const describe = process.argv.includes("--describe"); // 加 --describe 则解析后逐镜跑豆包 vision 描述
const transcribe = process.argv.includes("--transcribe"); // 加 --transcribe 则本地 whisper 听写台词并对齐到镜头

console.log("[parse:input] 导入视频:", input);
const result = await importAndParseVideo(input, {
  parse: { threshold, minShotDur, targetShots },
});

console.log("[parse:input] 导入结果:", result.imported.status, result.imported.videoPath);
if (result.imported.info) {
  console.log("[parse:input] 来源信息:", JSON.stringify(result.imported.info));
}
console.log("[parse:input] 视频元信息:", JSON.stringify(result.parsed.meta));
console.log(`[parse:input] 检测切点=${result.parsed.cutCount}  镜头数=${result.parsed.shotCount}`);
for (const s of result.parsed.shots) {
  const kf = s.keyframe ? path.basename(s.keyframe) : "(关键帧缺失)";
  console.log(`  镜${s.idx}: ${s.start}s-${s.end}s (${s.dur}s) -> ${kf}`);
}

if (describe) {
  console.log(`[parse:input] 逐镜画面描述中（豆包 vision，共 ${result.parsed.shots.length} 镜，顺序跑）...`);
  const descs = await describeShots(result.parsed.shots, {});
  const byIdx = new Map(descs.map((d) => [d.idx, d]));
  for (const s of result.parsed.shots) {
    const d = byIdx.get(s.idx);
    s.vlm = d ? { ok: d.ok, model: d.model, durationMs: d.durationMs, desc: d.desc, error: d.error } : null;
    if (d && d.ok) {
      console.log(`  镜${s.idx} [${d.durationMs}ms] ${d.desc.shotType || "?"} / ${d.desc.angle || "?"}: ${d.desc.summary || ""}`);
      if (d.desc.product) console.log(`         带货主体: ${d.desc.product}`);
      if (d.desc.onScreenText) console.log(`         画面文字: ${d.desc.onScreenText}`);
    } else {
      console.log(`  镜${s.idx} ❌ 描述失败: ${d ? d.error : "无返回"}`);
    }
  }
}

if (transcribe) {
  console.log("[parse:input] 听写台词中（本地 whisper，首次会下模型）...");
  const tr = await transcribeVideo(result.imported.videoPath, {});
  result.transcript = tr.ok
    ? { ok: true, language: tr.language, model: tr.model, text: tr.text, segments: tr.segments }
    : { ok: false, error: tr.error };
  if (tr.ok) {
    const byIdx = new Map(alignToShots(tr.segments, result.parsed.shots).map((a) => [a.idx, a]));
    for (const s of result.parsed.shots) s.dialogue = byIdx.get(s.idx)?.text || "";
    console.log("[parse:input] 全文台词:", tr.text);
    for (const s of result.parsed.shots) {
      if (s.dialogue) console.log(`  镜${s.idx} 台词: ${s.dialogue}`);
    }
  } else {
    console.log("[parse:input] ❌ 听写失败:", tr.error);
  }
}

// 分镜脚本成稿（把画面描述 + 台词拼成可读脚本；没跑 --describe/--transcribe 时只剩镜号时长）
for (const s of result.parsed.shots) s.script = composeShotScript(s);
result.storyboard = composeStoryboard(result);

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const base = path.basename(result.imported.videoPath).replace(/\.[^.]+$/, "");
const out = path.join(RESULTS_DIR, `${base}.shots.json`);
fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
const scriptOut = path.join(RESULTS_DIR, `${base}.script.txt`);
fs.writeFileSync(scriptOut, result.storyboard, "utf8");

console.log("\n========== 分镜脚本 ==========");
console.log(result.storyboard);
console.log("==============================");
console.log("[parse:input] 结果文件:", out);
console.log("[parse:input] 分镜脚本:", scriptOut);

