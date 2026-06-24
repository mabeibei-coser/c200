// 自测精解析入口：合成本地视频 -> importLocalVideo -> parseVideo。
// 不访问外网，只验证“导入层 + ffmpeg 切镜头/抽帧”通路。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importAndParseVideo } from "../lib/videoImport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.resolve(__dirname, "..", "data", "videos", "_synth-import-source.mp4");

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

await run("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2:r=10",
  "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=10",
  "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2:r=10",
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
  "-map", "[v]", "-pix_fmt", "yuv420p", tmp,
]);
console.log("[smoke-import] 合成测试片:", fs.existsSync(tmp) ? "OK" : "FAIL", tmp);

const r = await importAndParseVideo(tmp, {
  parse: { threshold: 0.08, minShotDur: 0.4 },
});

console.log("[smoke-import] imported:", r.imported.videoPath);
console.log("[smoke-import] meta:", JSON.stringify(r.parsed.meta));
console.log(`[smoke-import] 检测切点=${r.parsed.cutCount}  镜头数=${r.parsed.shotCount} (期望≈3)`);
for (const s of r.parsed.shots) {
  const kf = s.keyframe ? path.basename(s.keyframe) : "(无)";
  console.log(`  镜${s.idx}: ${s.start}s-${s.end}s (${s.dur}s) -> ${kf} ${s.keyframe && fs.existsSync(s.keyframe) ? "✓" : "✗"}`);
}

const ok = r.parsed.shotCount === 3 && r.parsed.shots.every((s) => s.keyframe && fs.existsSync(s.keyframe));
console.log(ok ? "[smoke-import] 精解析入口正常" : "[smoke-import] 与期望不符，需检查");
process.exit(ok ? 0 : 1);

