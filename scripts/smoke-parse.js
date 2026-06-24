// 自测 lib/videoParse.js 的 plumbing：用 ffmpeg 合成一段「红/绿/蓝 各2秒、硬切」的测试片，
// 跑 parseVideo，期望切出 3 个镜头、每镜抽到一张关键帧。
// 这只验证「ffmpeg 调用 + 切点解析 + 抽帧落地」管路通；真实视频的阈值到时拿真片调。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVideo } from "../lib/videoParse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.resolve(__dirname, "..", "data", "videos", "_synth-test.mp4");

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let e = "";
    p.stderr.on("data", (d) => (e += d));
    p.on("error", rej);
    p.on("close", (c) => res({ c, e }));
  });
}

fs.mkdirSync(path.dirname(tmp), { recursive: true });

// 白→黑→白：亮度反差拉满，确保两个硬切都被 scene 算法检到（scene 主要看亮度差）
await run("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2:r=10",
  "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=10",
  "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2:r=10",
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
  "-map", "[v]", "-pix_fmt", "yuv420p", tmp,
]);
console.log("[smoke-parse] 合成测试片:", fs.existsSync(tmp) ? "OK" : "FAIL", tmp);

// 阈值压低：纯色块对 scene 算法打分偏低（边缘案例），这里只为验证「多切点→多镜头」管路；
// 真实视频默认 0.3（parseVideo 内置），到时拿真片调。
const r = await parseVideo(tmp, { threshold: 0.08, minShotDur: 0.4 });
console.log("[smoke-parse] meta:", JSON.stringify(r.meta));
console.log(`[smoke-parse] 检测切点=${r.cutCount}  镜头数=${r.shotCount} (期望≈3)`);
for (const s of r.shots) {
  console.log(`  镜${s.idx}: ${s.start}s–${s.end}s (${s.dur}s) -> ${path.basename(s.keyframe)} ${fs.existsSync(s.keyframe) ? "✓" : "✗"}`);
}
const ok = r.shotCount === 3 && r.shots.every((s) => fs.existsSync(s.keyframe));
console.log(ok ? "[smoke-parse] 🟢 切镜头+抽帧 plumbing 正常" : "[smoke-parse] 🟡 与期望不符，需检查");
process.exit(ok ? 0 : 1);
