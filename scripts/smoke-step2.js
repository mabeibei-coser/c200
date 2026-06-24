// 冒烟测试：跑通 Step2 复刻洗稿整条流程（文字洗稿 + 图像复刻）。
// 没有真实产品图时，自动用 gpt-image-2 生成一张"模拟产品图"（磨砂黑签字笔），再复刻。
// 跑法：npm run smoke:step2                 （默认只复刻第 1 镜，省额度）
//      npm run smoke:step2 -- --limit=3     （复刻前 3 镜）
//      npm run smoke:step2 -- data/parse-results/xxx.shots.json --limit=2

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const ROOT = path.join(__dirname, "..");
const { generateImage } = await import("../lib/image.js");
const { runStep2 } = await import("../lib/step2.js");

function readArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) ? n : fallback;
}

// 找一张带画面描述的分镜表
function pickShotsFile() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (arg) return path.resolve(arg);
  const dir = path.join(ROOT, "data", "parse-results");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".shots.json"));
  // 优先选 shots 带 vlm 描述的
  const withVlm = files.find((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return (j.parsed?.shots || []).some((s) => s.vlm);
    } catch {
      return false;
    }
  });
  return path.join(dir, withVlm || files[0]);
}

// 准备模拟产品图（首次生成，之后复用）
async function ensureMockProduct() {
  const dir = path.join(ROOT, "data", "products");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "mock-pen.png");
  if (fs.existsSync(dest)) {
    console.log("[smoke-step2] 复用已有模拟产品图:", dest);
    return dest;
  }
  console.log("[smoke-step2] 生成模拟产品图（磨砂黑签字笔）...");
  const r = await generateImage({
    prompt: "一支磨砂质感的黑色金属签字笔，竖直放置，纯白背景，专业产品摄影，柔和影棚光，细节清晰，高级商务感",
    ratio: "3:4",
    route: "banana",
  });
  fs.copyFileSync(r.abs, dest);
  console.log(`[smoke-step2] 模拟产品图就绪（${r.durationMs}ms）:`, dest);
  return dest;
}

const file = pickShotsFile();
if (!file || !fs.existsSync(file)) {
  console.error("[smoke-step2] 找不到分镜表。先 npm run parse:input -- <视频> --describe --transcribe。");
  process.exit(2);
}
const result = JSON.parse(fs.readFileSync(file, "utf8"));
const limit = readArg("limit", 1);

const product = "一支磨砂黑色金属签字笔，笔身简约有质感，适合商务办公与送礼";
const requirement = "把原片场景洗成卖这支签字笔的带货短视频，亲切专业，台词原创不照搬";

console.log("[smoke-step2] 分镜表:", path.basename(file), `(${result.parsed.shots.length} 镜，本次复刻前 ${limit} 镜)`);

const penPath = await ensureMockProduct();

console.log("[smoke-step2] 跑 Step2（洗稿 + 复刻出图，每张约 60s）...");
const t0 = Date.now();
const r = await runStep2(result, { product, requirement, refImages: [penPath], limit });
console.log(`[smoke-step2] 总耗时 ${Date.now() - t0}ms  ok=${r.ok}  比例=${r.ratio}`);

if (!r.ok) {
  console.error("[smoke-step2] ❌ 失败 @", r.stage, ":", r.error);
  process.exit(1);
}

for (const s of r.shots) {
  console.log(`\n— 镜${s.idx} —`);
  console.log("新台词:", s.newDialogue || "(无)");
  console.log("生图提示:", s.imagePrompt);
  console.log("新图:", s.imageOk ? s.newImageRel : `❌ ${s.imageError}`);
}

// 存一份 Step2 结果
const outDir = path.join(ROOT, "data", "parse-results");
const base = path.basename(file).replace(/\.shots\.json$/, "");
const out = path.join(outDir, `${base}.step2.json`);
fs.writeFileSync(out, JSON.stringify({ product, requirement, ...r }, null, 2), "utf8");
console.log("\n[smoke-step2] 结果文件:", out);

const done = r.shots.slice(0, limit);
const ok = done.length > 0 && done.every((s) => s.imageOk);
console.log(ok ? "[smoke-step2] 🟢 Step2 复刻洗稿整条跑通" : "[smoke-step2] ❌ 有镜出图失败，需检查");
process.exit(ok ? 0 : 1);
