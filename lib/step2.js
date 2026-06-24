// C200 Step2 复刻洗稿 编排 —— 把"文字洗稿(lib/rewrite.js) + 图像复刻(lib/remake.js)"串起来：
// 输入：原分镜表 result + 产品参考图 refImages + 产品文字 product + 洗稿要求 requirement
// 输出：每镜 { 新说明, 新台词, 生图提示, 新图 }

import { rewriteShots } from "./rewrite.js";
import { remakeShots } from "./remake.js";

// 从视频宽高挑最接近的生图比例（gpt-image-2 只有几档）
export function ratioFromMeta(meta = {}) {
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return "1:1";
  const r = h / w;
  if (r >= 1.5) return "9:16";
  if (r >= 1.2) return "3:4";
  if (r <= 1 / 1.5) return "16:9";
  if (r <= 1 / 1.2) return "4:3";
  return "1:1";
}

// 完整 Step2。opts: { product, requirement, refImages[], ratio?, route?, useKeyframe?, limit? }
// limit 只限制"出图"的镜数（文字洗稿仍出全片），方便先小成本验证。
export async function runStep2(result, opts = {}) {
  const allShots = result?.parsed?.shots || [];
  const ratio = opts.ratio || ratioFromMeta(result?.parsed?.meta);

  const rw = await rewriteShots(allShots, {
    product: opts.product,
    requirement: opts.requirement,
    model: opts.rewriteModel,
  });
  if (!rw.ok) return { ok: false, stage: "rewrite", error: rw.error, shots: [] };

  const targets = opts.limit ? allShots.slice(0, opts.limit) : allShots;
  const imgs = await remakeShots(targets, rw.shots, {
    refImages: opts.refImages,
    ratio,
    route: opts.route,
    useKeyframe: opts.useKeyframe,
  });
  const imgByIdx = new Map(imgs.map((i) => [i.idx, i]));

  const shots = rw.shots.map((r) => {
    const im = imgByIdx.get(r.idx) || {};
    return {
      idx: r.idx,
      newSummary: r.newSummary,
      newDialogue: r.newDialogue,
      imagePrompt: r.imagePrompt,
      newImageRel: im.ok ? im.rel : null,
      imageOk: Boolean(im.ok),
      imageError: im.error || null,
    };
  });
  return { ok: true, ratio, rewriteModel: rw.model, shots };
}
