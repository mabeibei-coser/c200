// C200 视频解析模块 —— 输入一个本地视频文件，输出结构化「镜头表」。
// 只依赖 ffmpeg/ffprobe（已在 PATH）。不负责下载：视频怎么来的与本模块无关。
// 流程：ffprobe 取元信息 → ffmpeg 场景检测切镜头 → 每镜抽一张代表关键帧。
// 关键帧交给上层 lib/vlm.js 做逐镜描述；台词由 lib/asr.js 处理。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const FRAMES_DIR = path.join(DATA_DIR, "frames");

// 跑一个外部命令，收集 stdout/stderr（ffmpeg 的信息走 stderr）
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// 视频元信息：分辨率 / 帧率 / 时长
async function probe(videoPath) {
  const { out } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,duration",
    "-show_entries", "format=duration",
    "-of", "json",
    videoPath,
  ]);
  const j = JSON.parse(out || "{}");
  const st = (j.streams && j.streams[0]) || {};
  const dur = parseFloat(st.duration || (j.format && j.format.duration) || "0");
  const [n, d] = String(st.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = d ? n / d : 0;
  return {
    width: st.width || null,
    height: st.height || null,
    fps: +fps.toFixed(2),
    duration: +dur.toFixed(3),
  };
}

// 场景检测：返回所有「切点」时间戳（秒）。threshold 越高越不敏感（合并相似镜头）。
async function sceneCuts(videoPath, threshold) {
  const { code, err } = await run("ffmpeg", [
    "-i", videoPath,
    "-filter:v", `select='gt(scene,${threshold})',showinfo`,
    "-an", "-f", "null", "-",
  ]);
  // ffmpeg 场景检测正常会 exit 0；非零说明文件读不动，宁可报错也别静默退化成"整段=1镜"
  if (code !== 0) {
    throw new Error(`场景检测失败（ffmpeg exit ${code}）：${String(err).slice(-300).trim()}`);
  }
  const cuts = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(err))) cuts.push(parseFloat(m[1]));
  return cuts;
}

// 把切点 + 总时长 拼成镜头段；过短的碎镜头并入上一镜（防闪烁/转场被误切成一堆）
function buildShots(cuts, duration, minDur) {
  const bounds = [0, ...cuts.filter((t) => t > 0 && t < duration), duration];
  const uniq = [...new Set(bounds.map((t) => +t.toFixed(3)))].sort((a, b) => a - b);
  const raw = [];
  for (let i = 0; i < uniq.length - 1; i++) raw.push({ start: uniq[i], end: uniq[i + 1] });

  const merged = [];
  for (const s of raw) {
    const dur = s.end - s.start;
    if (merged.length && dur < minDur) merged[merged.length - 1].end = s.end;
    else merged.push({ ...s });
  }
  // 首镜兜底：其它位置的过短碎镜都向前合并了，唯独首镜没有"上一镜"可并，会逃逸成独立短镜头。
  // 若首镜过短且后面还有镜头，把它并入第二镜（全片只 1 镜时不动）。
  if (merged.length >= 2 && merged[0].end - merged[0].start < minDur) {
    merged[1].start = merged[0].start;
    merged.shift();
  }
  return merged.map((s, i) => ({
    idx: i + 1,
    start: +s.start.toFixed(3),
    end: +s.end.toFixed(3),
    dur: +(s.end - s.start).toFixed(3),
  }));
}

// 候选切点 + 场景分：低阈值多召回，每个切点带 scene_score，供"指定分镜数量"按强度排序。
async function sceneCutsScored(videoPath, lowThreshold = 0.1) {
  const { code, err } = await run("ffmpeg", [
    "-i", videoPath,
    "-filter:v", `select='gt(scene,${lowThreshold})',metadata=print`,
    "-an", "-f", "null", "-",
  ]);
  if (code !== 0) {
    throw new Error(`场景检测失败（ffmpeg exit ${code}）：${String(err).slice(-300).trim()}`);
  }
  // 输出里 pts_time:X 后面紧跟一行 lavfi.scene_score=Y，成对取出
  const cuts = [];
  const re = /pts_time:([0-9.]+)[\s\S]*?lavfi\.scene_score=([0-9.]+)/g;
  let m;
  while ((m = re.exec(err))) cuts.push({ time: parseFloat(m[1]), score: parseFloat(m[2]) });
  return cuts;
}

// 指定分镜数量：强制切成恰好 N 镜。真实切点够就取场景分最高的 N-1 个；不够就均匀按时间切。
function buildShotsForCount(candidates, duration, targetN) {
  const N = Math.max(1, Math.floor(targetN));
  const valid = candidates.filter((c) => c.time > 0.05 && c.time < duration - 0.05);
  let cutTimes;
  if (N <= 1) {
    cutTimes = [];
  } else if (valid.length >= N - 1) {
    cutTimes = valid
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, N - 1)
      .map((c) => c.time)
      .sort((a, b) => a - b);
  } else {
    // 真实切点不够，均匀切成 N 段
    cutTimes = [];
    for (let i = 1; i < N; i++) cutTimes.push(+((duration * i) / N).toFixed(3));
  }
  const bounds = [0, ...cutTimes, duration];
  const uniq = [...new Set(bounds.map((t) => +t.toFixed(3)))].sort((a, b) => a - b);
  const shots = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    shots.push({
      idx: i + 1,
      start: +uniq[i].toFixed(3),
      end: +uniq[i + 1].toFixed(3),
      dur: +(uniq[i + 1] - uniq[i]).toFixed(3),
    });
  }
  return shots;
}

// 每镜抽一张代表帧（取镜头中点，避免取到转场过渡帧）
// 抽帧失败（ffmpeg 非零退出或文件没落盘）返回 null，让上层把这镜标成"无关键帧"而不是给前端一条坏图路径。
async function extractKeyframe(videoPath, shot, outDir) {
  const mid = Math.max(0, shot.start + shot.dur / 2);
  const name = `shot-${String(shot.idx).padStart(2, "0")}.jpg`;
  const abs = path.join(outDir, name);
  const { code } = await run("ffmpeg", ["-ss", String(mid), "-i", videoPath, "-frames:v", "1", "-q:v", "3", "-y", abs]);
  if (code !== 0 || !fs.existsSync(abs)) return null;
  return abs;
}

// 主入口：本地视频 → 镜头表
// 返回 { meta, cutCount, shotCount, framesDir, shots:[{idx,start,end,dur,keyframe,keyframeRel}] }
export async function parseVideo(videoPath, opts = {}) {
  const { threshold = 0.3, minShotDur = 0.5, targetShots = null } = opts;
  if (!fs.existsSync(videoPath)) throw new Error(`视频文件不存在: ${videoPath}`);

  const meta = await probe(videoPath);
  if (!meta.duration) throw new Error("无法读取视频时长（文件可能损坏或非视频）");

  // 两种模式：指定了 targetShots 就强制切成 N 镜；否则按阈值自动切。
  let shots;
  let cutCount;
  if (targetShots && targetShots >= 1) {
    const candidates = await sceneCutsScored(videoPath, opts.lowThreshold ?? 0.1);
    shots = buildShotsForCount(candidates, meta.duration, targetShots);
    cutCount = shots.length - 1;
  } else {
    const cuts = await sceneCuts(videoPath, threshold);
    shots = buildShots(cuts, meta.duration, minShotDur);
    cutCount = cuts.length;
  }

  const base = path.basename(videoPath).replace(/\.[^.]+$/, "");
  const outDir = path.join(FRAMES_DIR, base);
  // 先清空再写：同一视频换参数重解析时，旧的 shot-NN.jpg（尤其镜头数变少时的高编号残帧）不会残留，
  // 保证关键帧与本轮镜头表严格一一对应。
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const s of shots) {
    s.keyframe = await extractKeyframe(videoPath, s, outDir);
    s.keyframeRel = s.keyframe ? `/frames/${base}/${path.basename(s.keyframe)}` : null;
  }

  return { meta, cutCount, shotCount: shots.length, framesDir: outDir, shots };
}
