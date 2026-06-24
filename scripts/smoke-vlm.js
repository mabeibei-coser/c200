// 冒烟测试：验证豆包 vision 能对一张真实关键帧输出结构化镜头描述。
// 跑法：npm run smoke:vlm
//      指定帧：npm run smoke:vlm -- data/frames/<目录>/shot-01.jpg
//      换模型：VLM_MODEL=doubao-seed-1-6-flash-250615 npm run smoke:vlm

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const { describeShot } = await import("../lib/vlm.js");

// 找一张可用关键帧：优先命令行指定，否则在 data/frames 里挑第一张 jpg
function pickFrame() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (arg) return path.resolve(arg);
  const framesDir = path.join(__dirname, "..", "data", "frames");
  if (!fs.existsSync(framesDir)) return null;
  for (const sub of fs.readdirSync(framesDir)) {
    const dir = path.join(framesDir, sub);
    if (!fs.statSync(dir).isDirectory()) continue;
    const jpg = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".jpg"));
    if (jpg) return path.join(dir, jpg);
  }
  return null;
}

const frame = pickFrame();
if (!frame || !fs.existsSync(frame)) {
  console.error("[smoke-vlm] 找不到关键帧。先跑 npm run smoke:import 生成帧，或传一张路径。");
  process.exit(2);
}
if (!process.env.IMAGE_API_KEY && !process.env.VLM_API_KEY) {
  console.error("[smoke-vlm] 没有火山 ARK key（IMAGE_API_KEY / VLM_API_KEY 都空）。先填 .env.local。");
  process.exit(2);
}

console.log("[smoke-vlm] 关键帧:", frame, `(${fs.statSync(frame).size} 字节)`);
console.log("[smoke-vlm] 模型:", process.env.VLM_MODEL || "doubao-seed-1-6-250615", "调用中...");

const r = await describeShot(frame);
console.log(`[smoke-vlm] 耗时 ${r.durationMs}ms  ok=${r.ok}`);

if (!r.ok) {
  console.error("[smoke-vlm] ❌ 失败：", r.error);
  if (r.raw) console.error("[smoke-vlm] 原始返回（前 300 字）：", String(r.raw).slice(0, 300));
  process.exit(1);
}

console.log("[smoke-vlm] 结构化描述：");
console.log(JSON.stringify(r.desc, null, 2));

const ok = r.desc && typeof r.desc.summary === "string" && r.desc.summary.length > 0;
console.log(ok ? "[smoke-vlm] 🟢 逐镜描述通路正常（拿到结构化 summary）" : "[smoke-vlm] ❌ 缺 summary 字段，需检查模型/提示词");
process.exit(ok ? 0 : 1);
