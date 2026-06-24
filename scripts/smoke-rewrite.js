// 冒烟测试：验证 Step2 文字洗稿——拿一张已存的分镜表，改写成"卖新产品"的版本。
// 跑法：npm run smoke:rewrite
//      指定分镜表：npm run smoke:rewrite -- data/parse-results/xxx.shots.json
// 需要先有带画面描述的分镜表（先 npm run parse:input -- <视频> --describe --transcribe）。

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const { rewriteShots } = await import("../lib/rewrite.js");

function pickShotsFile() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (arg) return path.resolve(arg);
  const dir = path.join(__dirname, "..", "data", "parse-results");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => n.endsWith(".shots.json"));
  return f ? path.join(dir, f) : null;
}

const file = pickShotsFile();
if (!file || !fs.existsSync(file)) {
  console.error("[smoke-rewrite] 找不到分镜表。先 npm run parse:input -- <视频> --describe --transcribe 生成一个。");
  process.exit(2);
}

const result = JSON.parse(fs.readFileSync(file, "utf8"));
const shots = result.parsed?.shots || [];
const product = "一支磨砂黑色金属签字笔，笔身简约有质感，适合商务办公与送礼";
const requirement = "把原片的场景洗成卖这支签字笔的带货短视频，保持亲切专业的语气，台词不要照搬原句、要原创";

console.log("[smoke-rewrite] 分镜表:", path.basename(file), `(${shots.length} 镜)`);
console.log("[smoke-rewrite] 新产品:", product);
console.log("[smoke-rewrite] 洗稿要求:", requirement);
console.log("[smoke-rewrite] 改写中（豆包文本，一次出整片）...");

const t0 = Date.now();
const r = await rewriteShots(shots, { product, requirement });
console.log(`[smoke-rewrite] 耗时 ${Date.now() - t0}ms  ok=${r.ok}`);

if (!r.ok) {
  console.error("[smoke-rewrite] ❌ 失败：", r.error);
  process.exit(1);
}

for (const s of r.shots) {
  console.log(`\n— 镜${s.idx} —`);
  console.log("新画面:", s.newSummary);
  if (s.newDialogue) console.log("新台词:", s.newDialogue);
  console.log("生图提示:", s.imagePrompt);
}

const ok = r.shots.length === shots.length && r.shots.every((s) => s.imagePrompt);
console.log(ok ? "\n[smoke-rewrite] 🟢 文字洗稿通路正常" : "\n[smoke-rewrite] ❌ 部分镜缺生图提示，需检查");
process.exit(ok ? 0 : 1);
