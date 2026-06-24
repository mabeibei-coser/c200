// 冒烟测试：验证生图线路是否支持「图生图 / 参考图编辑」(images.edit)。
// 这是 C200 第②步的命门——A700 只用过文生图，gpt-image-2 经 BananaRouter 能否图生图未知。
// 跑法：node scripts/smoke-image.js   （切线路：SMOKE_ROUTE=seedream node scripts/smoke-image.js）

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const { generateImage, editImage } = await import("../lib/image.js");

const route = process.env.SMOKE_ROUTE || "banana";
const model = route === "seedream" ? process.env.IMAGE_MODEL : process.env.BANANA_MODEL;

async function main() {
  console.log(`[smoke] route=${route}  model=${model}`);

  // 步骤1 文生图：先造一张"基底图"（笔记本放木桌），作为图生图的输入
  console.log("[smoke] 步骤1/2 文生图：基底图（笔记本平放木桌，俯拍）...");
  let base;
  try {
    base = await generateImage({
      prompt: "一本黑色精装笔记本平放在浅色木桌中央，俯拍视角，柔和自然光，简约产品摄影风格，背景干净",
      ratio: "1:1",
      route,
    });
    console.log(`[smoke] ✅ 文生图成功  ${base.abs}  (${base.durationMs}ms)`);
  } catch (e) {
    console.error(`[smoke] ❌ 文生图失败：${e.status || ""} ${e.message}`);
    console.error("[smoke] 结论：该线路连文生图都没通，先查 key/额度/网络。");
    process.exit(2);
  }

  // 步骤2 图生图：把笔记本换成钢笔，保持构图——这是真正要验的能力
  console.log("[smoke] 步骤2/2 图生图：换主体（笔记本→钢笔，保持构图/桌面/光线）...");
  try {
    const edited = await editImage({
      prompt: "保持原图的构图、桌面、光线和拍摄角度完全不变，只把画面中央的笔记本替换成一支银色金属钢笔",
      images: [base.abs],
      ratio: "1:1",
      route,
    });
    console.log(`[smoke] ✅ 图生图成功  ${edited.abs}  (${edited.durationMs}ms)`);
    console.log(`\n[smoke] 🟢 结论：route=${route}（${model}）支持 images.edit 图生图/参考图。C200 第②步可用此线路。`);
  } catch (e) {
    console.error(`[smoke] ❌ 图生图失败：${e.status || ""} ${e.message}`);
    console.error(`\n[smoke] 🔴 结论：route=${route}（${model}）不支持 images.edit。建议改用 Seedream：\n          SMOKE_ROUTE=seedream node scripts/smoke-image.js`);
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("[smoke] 未预期错误：", e);
  process.exit(1);
});
