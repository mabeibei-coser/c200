// C200 Step2 图像复刻 —— 拿"产品参考图 + 洗稿生成的生图提示词"，用 gpt-image-2(images.edit)
// 给每个分镜出一张换成新产品的新图。复用 lib/image.js 的 editImage。
// 默认只用产品参考图（让 imagePrompt 描述构图）；要把原帧也当构图锚点就传 opts.useKeyframe=true。

import fs from "node:fs";
import { editImage } from "./image.js";

// 单镜出图：refImages=产品参考图路径数组，imagePrompt=洗稿给的生图提示词
export async function remakeShot({ imagePrompt, refImages = [], keyframe = null }, opts = {}) {
  const images = [...refImages.filter((p) => p && fs.existsSync(p))];
  if (opts.useKeyframe && keyframe && fs.existsSync(keyframe)) images.push(keyframe);
  if (!images.length) return { ok: false, error: "没有可用的产品参考图" };
  if (!imagePrompt) return { ok: false, error: "没有生图提示词" };
  try {
    const r = await editImage({
      prompt: imagePrompt,
      images,
      ratio: opts.ratio || "1:1",
      route: opts.route || "banana",
    });
    return { ok: true, rel: r.rel, abs: r.abs, model: r.model, durationMs: r.durationMs };
  } catch (e) {
    return { ok: false, error: `${e.status || ""} ${e.message}`.trim() };
  }
}

// 批量出图（顺序跑，避免限流）。shots=原分镜(取 keyframe)，rewritten=洗稿结果(取 imagePrompt)。
// 返回每镜 { idx, ok, rel, abs?, error? }。
export async function remakeShots(shots, rewritten, opts = {}) {
  const byIdx = new Map((rewritten || []).map((r) => [r.idx, r]));
  const out = [];
  for (const s of shots || []) {
    const rw = byIdx.get(s.idx) || {};
    const prompt = rw.imagePrompt || rw.newSummary || "";
    const r = await remakeShot({ imagePrompt: prompt, refImages: opts.refImages, keyframe: s.keyframe }, opts);
    out.push({ idx: s.idx, ...r });
  }
  return out;
}
