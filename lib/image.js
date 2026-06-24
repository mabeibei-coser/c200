// C200 生图模块 —— 从 A700 lib/image.js 改造而来。
// 与 A700 的关键差异：A700 只用文生图(generateImage)；C200 新增图生图/参考图编辑(editImage)，
// 用于「保持原构图、只把主体产品换成用户的产品」这一核心动作。
// 两条线路：banana = gpt-image-2（用户的 "Image2"，默认）；seedream = 火山方舟豆包 Seedream（备选/兜底）。

import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(path.resolve(__dirname, ".."), "data", "images");

// 把图片 buffer 落地，返回 { rel(网页相对路径), abs(本机绝对路径) }
function saveImage(buf, ext = "png") {
  const now = new Date();
  const sub = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = path.join(IMAGES_DIR, sub);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(8).toString("hex") + "." + ext;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf);
  return { rel: `/images/${sub}/${name}`, abs };
}

function bananaClient() {
  return new OpenAI({
    apiKey: process.env.BANANA_API_KEY || "no-key",
    baseURL: process.env.BANANA_API_URL || "https://api.bananarouter.com/v1",
  });
}
function volcanoClient() {
  return new OpenAI({
    apiKey: process.env.IMAGE_API_KEY || "no-key",
    baseURL: process.env.IMAGE_API_URL || "https://ark.cn-beijing.volces.com/api/v3",
  });
}

// gpt-image 尺寸只有 3 档；按比例就近映射
const BANANA_SIZE = { "1:1": "1024x1024", "4:3": "1536x1024", "16:9": "1536x1024", "3:4": "1024x1536", "9:16": "1024x1536" };
const VOLC_SIZE = { "1:1": "2048x2048", "4:3": "2304x1728", "16:9": "2560x1440", "3:4": "1728x2304", "9:16": "1440x2560" };

// 从 OpenAI images 响应里取出图片 buffer（兼容 b64_json 与 url 两种返回）
async function pickImage(resp) {
  const d = resp?.data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, "base64");
  if (d?.url) {
    const res = await fetch(d.url);
    if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("生图返回为空");
}

// 文生图：纯文字 → 图片
export async function generateImage({ prompt, ratio = "1:1", route = "banana" }) {
  const startMs = Date.now();
  if (route === "seedream") {
    const client = volcanoClient();
    const model = process.env.IMAGE_MODEL || "doubao-seedream-5-0-260128";
    const size = VOLC_SIZE[ratio] || VOLC_SIZE["1:1"];
    const resp = await client.images.generate(
      { model, prompt, size, response_format: "url", watermark: process.env.IMAGE_WATERMARK !== "false" },
      { timeout: 120000 }
    );
    const buf = await pickImage(resp);
    return { ...saveImage(buf), model, size, route, durationMs: Date.now() - startMs };
  }
  const client = bananaClient();
  const model = process.env.BANANA_MODEL || "gpt-image-2";
  const size = BANANA_SIZE[ratio] || BANANA_SIZE["1:1"];
  const resp = await client.images.generate({ model, prompt, size, quality: "high" }, { timeout: 180000 });
  const buf = await pickImage(resp);
  return { ...saveImage(buf), model, size, route: "banana", durationMs: Date.now() - startMs };
}

// 图生图 / 参考图编辑：1 张或多张参考图 + prompt → 保持构图换主体
// images: 参考图的本机绝对路径数组（或单个路径）。多图融合时第一张通常当主体、其余当场景/风格参考。
export async function editImage({ prompt, images, ratio = "1:1", route = "banana" }) {
  const startMs = Date.now();
  const paths = Array.isArray(images) ? images : [images];
  const files = paths.map((p) => fs.createReadStream(p));
  if (route === "seedream") {
    const client = volcanoClient();
    const model = process.env.IMAGE_EDIT_MODEL || process.env.IMAGE_MODEL || "doubao-seedream-5-0-260128";
    const resp = await client.images.edit(
      { model, image: files.length > 1 ? files : files[0], prompt, response_format: "url" },
      { timeout: 180000 }
    );
    const buf = await pickImage(resp);
    return { ...saveImage(buf), model, route, durationMs: Date.now() - startMs };
  }
  const client = bananaClient();
  const model = process.env.BANANA_MODEL || "gpt-image-2";
  const size = BANANA_SIZE[ratio] || BANANA_SIZE["1:1"];
  const resp = await client.images.edit(
    { model, image: files.length > 1 ? files : files[0], prompt, size },
    { timeout: 180000 }
  );
  const buf = await pickImage(resp);
  return { ...saveImage(buf), model, size, route: "banana", durationMs: Date.now() - startMs };
}
