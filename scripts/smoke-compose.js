// 冒烟测试：把 data/clips/ 里的片段合成成片（不联网、不计费，纯 ffmpeg）。
// 只有 1 段时把它用两次，验证多段拼接通路。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeClips } from "../lib/compose.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, "..", "data", "clips");

if (!fs.existsSync(CLIPS_DIR)) {
  console.error("[smoke-compose] 没有 data/clips/。先 npm run smoke:seedance 生成至少一段。");
  process.exit(2);
}
let clips = fs
  .readdirSync(CLIPS_DIR)
  .filter((n) => n.toLowerCase().endsWith(".mp4"))
  .map((n) => path.join(CLIPS_DIR, n));
if (clips.length === 0) {
  console.error("[smoke-compose] data/clips/ 里没有 mp4。先 npm run smoke:seedance。");
  process.exit(2);
}
if (clips.length === 1) {
  console.log("[smoke-compose] 只有 1 段，复用两次验证拼接通路。");
  clips = [clips[0], clips[0]];
}

console.log(`[smoke-compose] 合成 ${clips.length} 段...`);
const r = await composeClips(clips, { name: "smoke-final.mp4" });
console.log(`ok=${r.ok}`);
if (!r.ok) {
  console.error("[smoke-compose] ❌ 失败:", r.error);
  process.exit(1);
}

function ffprobe(p) {
  return new Promise((res) => {
    const c = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "default=nw=1", p]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => res(out));
  });
}
const probe = await ffprobe(r.finalPath);
console.log(`[smoke-compose] 成片: ${r.finalRel}  ${r.width}x${r.height}`);
console.log("[smoke-compose] ffprobe:", probe.replace(/\n/g, " ").trim());

const ok = probe.includes("codec_type=video");
console.log(ok ? "[smoke-compose] 🟢 合成通路正常" : "[smoke-compose] ❌ 产物异常");
process.exit(ok ? 0 : 1);
