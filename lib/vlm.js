// C200 画面理解模块 —— 给一张镜头关键帧，用讯飞 vision（Qwen-VL，OpenAI 兼容）输出结构化「镜头描述」。
// 用途：复刻参考视频时，先逐镜看懂"这镜在拍什么、主体是什么、景别/角度/光线"，
// 再喂给下游分镜脚本生成，并定位"可被替换的带货主体"。
// 用讯飞 key（VLM_API_KEY），OpenAI 兼容口，跟豆包同样写法；模型/端点可用 VLM_MODEL/VLM_API_URL 覆盖。

import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "xopqwen36v35b"; // 讯飞 MaaS 上的 Qwen 视觉模型（已实测可看图）
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

// 关键帧 → data URL（ARK vision 接受 base64 内联图，免得把本机帧暴露成公网 URL）
function imageToDataUrl(absPath) {
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// 宽松解析模型返回的 JSON：剥 ```json 围栏、截首尾花括号，尽量不因格式抖动失败
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

const SYSTEM_PROMPT = `你是专业分镜师。我会给你一条带货短视频里某个镜头的关键帧，目的是"复刻这条视频、把里面的带货主体换成别的产品"。
请只依据画面所见来描述，不要编造看不到的东西；看不清/没有的字段填空字符串 ""。
严格只输出一个 JSON 对象（不要 markdown 围栏、不要多余文字），字段如下：
{
  "summary": "一句话概括这个镜头在拍什么",
  "subject": "画面最主要的主体（人/产品/物体），尽量具体",
  "product": "若画面里有被展示/带货的产品主体，写它是什么；没有就 \\"\\"",
  "shotType": "景别，从 特写/近景/中景/全景/远景 里选最接近的",
  "angle": "机位角度，如 俯拍/平拍/仰拍 + 正面/侧面/背面，能判断多少写多少",
  "composition": "主体在画面里的位置、前景与背景的关系",
  "lighting": "光线与色调，如 柔光/硬光、冷暖、明暗",
  "setting": "场景/背景环境",
  "onScreenText": "画面里出现的文字，逐条照抄；没有就 \\"\\""
}`;

// 描述单张关键帧 → { ok, desc, model, durationMs, attempts, error?, raw? }
// 失败不抛错，返回 ok:false，便于批量时单镜失败不拖垮整批。
// 带重试：火山 ARK 偶发瞬时 Connection error，连接类失败或 JSON 崩了都退避重试几次。
export async function describeShot(keyframePath, opts = {}) {
  const model = opts.model || process.env.VLM_MODEL || DEFAULT_MODEL;
  const maxAttempts = Math.max(1, opts.retries ?? 3);
  const startMs = Date.now();
  if (!keyframePath || !fs.existsSync(keyframePath)) {
    return { ok: false, error: "关键帧不存在或为空", desc: null, model, durationMs: 0 };
  }
  const dataUrl = imageToDataUrl(keyframePath);
  let lastErr = "";
  let lastRaw;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await vlmClient().chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: opts.hint || "请描述这个镜头。" },
              ],
            },
          ],
          max_tokens: opts.maxTokens || 700,
          temperature: opts.temperature ?? 0.2,
        },
        { timeout: opts.timeoutMs || 90000 }
      );
      const raw = resp.choices?.[0]?.message?.content || "";
      const desc = parseJsonLoose(raw);
      if (desc) return { ok: true, desc, model, durationMs: Date.now() - startMs, attempts: attempt };
      lastErr = "VLM 返回的不是合法 JSON";
      lastRaw = raw;
    } catch (e) {
      lastErr = `${e.status || ""} ${e.message}`.trim();
    }
    if (attempt < maxAttempts) await sleep(700 * attempt);
  }
  return { ok: false, error: lastErr, raw: lastRaw, desc: null, model, durationMs: Date.now() - startMs, attempts: maxAttempts };
}

// 给一组镜头逐个描述（顺序执行，避免 ARK 限流）。shots 取自 parseVideo 的结果，需带 keyframe 绝对路径。
// 返回每镜：{ idx, start, end, dur, ok, desc, model, durationMs, error? }
export async function describeShots(shots, opts = {}) {
  const out = [];
  for (const shot of shots || []) {
    const r = await describeShot(shot.keyframe, opts);
    out.push({ idx: shot.idx, start: shot.start, end: shot.end, dur: shot.dur, ...r });
  }
  return out;
}
