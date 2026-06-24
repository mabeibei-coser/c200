// C200 分镜脚本成稿 —— 把镜头表（切点 + 关键帧 + 豆包vision画面描述 + whisper台词）
// 拼成一份可读的「分镜脚本」。纯格式化，不调任何模型、不花钱。
// 没跑 --describe/--transcribe 时字段会稀疏，脚本只剩镜号与时长，也照样能出。

function fmt(s) {
  const n = Number(s);
  return Number.isFinite(n) ? `${n.toFixed(2)}s` : "?";
}

// 单镜成稿（多行字符串）
export function composeShotScript(shot) {
  const d = (shot.vlm && shot.vlm.ok && shot.vlm.desc) || {};
  const lines = [`【镜${shot.idx}】 ${fmt(shot.start)}–${fmt(shot.end)}（时长 ${fmt(shot.dur)}）`];

  const sa = [d.shotType, d.angle].filter(Boolean).join(" / ");
  if (sa) lines.push(`景别机位：${sa}`);
  if (d.summary) lines.push(`画面：${d.summary}`);

  const detail = [
    d.subject && `主体 ${d.subject}`,
    d.composition && `构图 ${d.composition}`,
    d.lighting && `光线 ${d.lighting}`,
    d.setting && `场景 ${d.setting}`,
  ].filter(Boolean);
  if (detail.length) lines.push(`细节：${detail.join("；")}`);

  if (d.product) lines.push(`带货主体：${d.product}`);
  if (d.onScreenText) lines.push(`画面文字：${d.onScreenText}`);
  if (shot.dialogue) lines.push(`台词：${shot.dialogue}`);

  return lines.join("\n");
}

// 整片成稿：抬头 + 各镜拼接
export function composeStoryboard(result) {
  const shots = result?.parsed?.shots || [];
  const meta = result?.parsed?.meta || {};
  const head = `分镜脚本 · 共 ${shots.length} 镜 · 时长 ${fmt(meta.duration)} · ${meta.width || "?"}×${meta.height || "?"}`;
  return [head, ...shots.map(composeShotScript)].join("\n\n");
}
