// 冒烟测试：火山 Seedance 图生视频跑通（会真生成 1 段，按 token 计费，小额）。
// 跑法：npm run smoke:seedance                  （自动找一张 Step2 复刻图/产品图当输入）
//      npm run smoke:seedance -- data/images/xxx.png

import dotenv from "dotenv";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const { generateClip } = await import("../lib/seedance.js");
const ROOT = path.join(__dirname, "..");

function findPng(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const hit = findPng(p);
      if (hit) return hit;
    } else if (/\.(png|jpg|jpeg)$/i.test(name)) {
      return p;
    }
  }
  return null;
}

function pickImage() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (arg) return path.resolve(arg);
  return findPng(path.join(ROOT, "data", "images")) || path.join(ROOT, "data", "products", "mock-pen.png");
}

const img = pickImage();
if (!img || !fs.existsSync(img)) {
  console.error("[smoke-seedance] 找不到参考图。先跑 Step2 复刻，或传一张图路径。");
  process.exit(2);
}
if (!process.env.IMAGE_API_KEY && !process.env.VIDEO_API_KEY) {
  console.error("[smoke-seedance] 没有火山 ARK key。先填 .env.local。");
  process.exit(2);
}

console.log("[smoke-seedance] 输入图:", img);
console.log("[smoke-seedance] 生成中（火山 Seedance，约 1-3 分钟，会计费）...");

const r = await generateClip({
  imagePath: img,
  prompt: "镜头缓慢推近，产品主体自然展示，画面稳定不晃",
  ratio: "9:16",
  duration: 5,
  resolution: "720p",
  idx: 1,
});

console.log(`[smoke-seedance] 耗时 ${r.durationMs}ms  ok=${r.ok}`);
if (!r.ok) {
  console.error("[smoke-seedance] ❌ 失败:", r.error);
  process.exit(1);
}
console.log(`[smoke-seedance] 片段: ${r.clipRel}  ${(r.bytes / 1024 / 1024).toFixed(2)}MB  ${r.resolution}/${r.duration}s`);

// ffprobe 验证是个真视频
function ffprobe(p) {
  return new Promise((res) => {
    const c = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "default=nw=1", p]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => res(out));
  });
}
const probe = await ffprobe(r.clipPath);
console.log("[smoke-seedance] ffprobe:", probe.replace(/\n/g, " ").trim());

const ok = probe.includes("codec_type=video");
console.log(ok ? "[smoke-seedance] 🟢 图生视频跑通" : "[smoke-seedance] ❌ 产物不是有效视频");
process.exit(ok ? 0 : 1);
