// C200 Step2 复刻洗稿（文字）—— 拿原视频的分镜表 + 新产品 + 洗稿要求，用讯飞 Qwen 文本逐镜改写，
// 一次调用改写整张表（保证台词跨镜连贯），输出每镜：新画面描述 / 新台词 / 给图像模型的提示词。
// 复用 lib/vlm.js 同一套讯飞 key（VLM_API_KEY）；模型可用 REWRITE_MODEL 覆盖。

import OpenAI from "openai";

const DEFAULT_MODEL = "xopqwen36v35b"; // 讯飞 Qwen（视觉模型也能做纯文本洗稿）
const DEFAULT_BASE = "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2"; // 讯飞 OpenAI 兼容口

function vlmClient() {
  return new OpenAI({
    apiKey: process.env.VLM_API_KEY || "no-key",
    baseURL: process.env.VLM_API_URL || DEFAULT_BASE,
    maxRetries: 2,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("{")) {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `你是带货短视频"复刻洗稿"助手。用户要复刻一条参考视频：保留它的拍摄手法、构图、景别、节奏，但把画面里的带货主体换成用户的新产品，并把台词改写成不与原片雷同的原创表达。
我会给你一个 JSON：新产品、洗稿要求、原分镜（每镜的景别/角度/画面/构图/光线/场景/台词）。
请逐镜改写，严格只输出一个 JSON 对象（不要 markdown 围栏、不要多余文字）：
{
  "shots": [
    {
      "idx": 镜号(与原分镜对应),
      "newSummary": "改写后这一镜的画面：把主体换成新产品，但保留原镜的景别/角度/构图/光线",
      "newDialogue": "改写后的台词：贴合新产品、符合洗稿要求、不与原片雷同；原片该镜没台词就填 \\"\\"",
      "imagePrompt": "给图像生成模型的中文提示词：在保持原镜构图/景别/角度/光线不变的前提下，把画面主体替换成新产品，简洁、可执行、只描述画面不要解释"
    }
  ]
}
硬要求：① 每镜都要出，idx 与原分镜一一对应；② 保留每镜的景别/角度/构图/光线；③ 不要编造新产品不具备的卖点；④ 台词改写要遵循洗稿要求。`;

// 把分镜表压成给模型的精简结构（兼容 s.vlm 是 {ok,desc} 或直接是 desc 两种形态）
function flattenShots(shots) {
  return (shots || []).map((s) => {
    const d = (s.vlm && (s.vlm.desc || s.vlm)) || {};
    return {
      idx: s.idx,
      时长: s.dur,
      景别: d.shotType || "",
      角度: d.angle || "",
      画面: d.summary || "",
      构图: d.composition || "",
      光线: d.lighting || "",
      场景: d.setting || "",
      台词: s.dialogue || "",
    };
  });
}

// 复刻洗稿（文字）：shots=原分镜表，opts.product=新产品描述，opts.requirement=洗稿要求
// 返回 { ok, model, shots:[{idx,newSummary,newDialogue,imagePrompt}] }；失败不抛错。
export async function rewriteShots(shots, opts = {}) {
  const product = (opts.product || "").trim() || "（用户未填具体产品，按洗稿要求合理决定）";
  const requirement =
    (opts.requirement || "").trim() ||
    "保留原片构图/景别/节奏，把带货主体换成新产品，台词改写成不与原片雷同的原创表达。";
  const model = opts.model || process.env.REWRITE_MODEL || process.env.VLM_MODEL || DEFAULT_MODEL;
  const maxAttempts = Math.max(1, opts.retries ?? 3);

  const user = JSON.stringify({ 新产品: product, 洗稿要求: requirement, 原分镜: flattenShots(shots) });

  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await vlmClient().chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
          max_tokens: opts.maxTokens || 2200,
          temperature: opts.temperature ?? 0.7,
        },
        { timeout: opts.timeoutMs || 120000 }
      );
      const parsed = parseJsonLoose(resp.choices?.[0]?.message?.content || "");
      const arr = parsed && parsed.shots;
      if (Array.isArray(arr) && arr.length) {
        const byIdx = new Map(arr.map((x) => [x.idx, x]));
        const out = (shots || []).map((s) => {
          const r = byIdx.get(s.idx) || {};
          return {
            idx: s.idx,
            newSummary: r.newSummary || "",
            newDialogue: r.newDialogue || "",
            imagePrompt: r.imagePrompt || "",
          };
        });
        return { ok: true, model, shots: out };
      }
      lastErr = "洗稿返回的不是预期 JSON（缺 shots 数组）";
    } catch (e) {
      lastErr = `${e.status || ""} ${e.message}`.trim();
    }
    if (attempt < maxAttempts) await sleep(800 * attempt);
  }
  return { ok: false, error: lastErr, shots: [] };
}
