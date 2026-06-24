const els = {
  form: document.querySelector("#parse-form"),
  modeUrl: document.querySelector("#mode-url"),
  modeUpload: document.querySelector("#mode-upload"),
  urlField: document.querySelector("#url-field"),
  urlHint: document.querySelector("#url-hint"),
  cookiesField: document.querySelector("#cookies-field"),
  cookiesInput: document.querySelector("#cookies-input"),
  cookiesName: document.querySelector("#cookies-name"),
  uploadField: document.querySelector("#upload-field"),
  urlInput: document.querySelector("#url-input"),
  fileInput: document.querySelector("#file-input"),
  fileName: document.querySelector("#file-name"),
  threshold: document.querySelector("#threshold-input"),
  minShot: document.querySelector("#min-shot-input"),
  shotsInput: document.querySelector("#shots-input"),
  describeInput: document.querySelector("#describe-input"),
  transcribeInput: document.querySelector("#transcribe-input"),
  submit: document.querySelector("#submit-button"),
  submitLabel: document.querySelector("#submit-label"),
  statusLine: document.querySelector("#status-line"),
  statusText: document.querySelector("#status-text"),
  errorBox: document.querySelector("#error-box"),
  empty: document.querySelector("#empty-state"),
  result: document.querySelector("#result-view"),
  title: document.querySelector("#result-title"),
  subtitle: document.querySelector("#result-subtitle"),
  statDuration: document.querySelector("#stat-duration"),
  statSize: document.querySelector("#stat-size"),
  statFps: document.querySelector("#stat-fps"),
  statShots: document.querySelector("#stat-shots"),
  cutCount: document.querySelector("#cut-count"),
  frameCount: document.querySelector("#frame-count"),
  shotsBody: document.querySelector("#shots-body"),
  frameGrid: document.querySelector("#frame-grid"),
  // Step2 复刻洗稿
  step2Sub: document.querySelector("#step2-sub"),
  step2Form: document.querySelector("#step2-form"),
  refInput: document.querySelector("#ref-input"),
  refName: document.querySelector("#ref-name"),
  refPreview: document.querySelector("#ref-preview"),
  productInput: document.querySelector("#product-input"),
  limitInput: document.querySelector("#limit-input"),
  requirementInput: document.querySelector("#requirement-input"),
  step2Submit: document.querySelector("#step2-submit"),
  step2Label: document.querySelector("#step2-label"),
  step2Status: document.querySelector("#step2-status"),
  step2StatusText: document.querySelector("#step2-status-text"),
  step2Error: document.querySelector("#step2-error"),
  step2Grid: document.querySelector("#step2-grid"),
};

let mode = "url";
let status = "idle";
let lastResult = null; // 上一步解析结果，Step2 复刻时回传给后端

// 与 lib/videoImport.js 的 extractFirstHttpUrl 逐字保持一致，改一处必须同步改另一处。
function extractFirstHttpUrl(input) {
  const match = String(input || "").match(/https?:\/\/[^\s"'<>，。；、！？（）【】《》「」…一-鿿]+/i);
  return match ? match[0].replace(/[)\]，。、；！？.,]+$/g, "") : null;
}

function fmtSeconds(value) {
  if (value == null) return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(2)}s`;
}

function fileName(input) {
  if (!input) return "-";
  return String(input).split(/[\\/]/).pop();
}

// 去掉开头的 /，让资源/接口路径相对当前页面解析——根部署(/)和子路径部署(/c200/)都正确
function rel(p) {
  return p ? String(p).replace(/^\//, "") : p;
}

function setText(node, value) {
  node.textContent = value == null ? "" : String(value);
}

function setMode(next) {
  mode = next;
  els.modeUrl.classList.toggle("active", mode === "url");
  els.modeUpload.classList.toggle("active", mode === "upload");
  els.urlField.classList.toggle("hidden", mode !== "url");
  els.cookiesField.classList.toggle("hidden", mode !== "url");
  els.uploadField.classList.toggle("hidden", mode !== "upload");
  updateSubmit();
}

function setStatus(next, message) {
  status = next;
  els.statusLine.className = `status-line ${next}`;
  setText(els.statusText, message);
  els.submit.classList.toggle("running", next === "running");
  setText(els.submitLabel, next === "running" ? "解析中" : "开始精解析");
  updateSubmit();
}

function setError(message) {
  if (!message) {
    els.errorBox.classList.add("hidden");
    setText(els.errorBox, "");
    return;
  }
  setText(els.errorBox, message);
  els.errorBox.classList.remove("hidden");
}

function updateSubmit() {
  const extractedUrl = extractFirstHttpUrl(els.urlInput.value);
  if (mode === "url") {
    if (extractedUrl) {
      els.urlHint.textContent = `已识别链接：${extractedUrl}`;
      els.urlHint.classList.add("ready");
    } else {
      els.urlHint.textContent = "可直接粘贴抖音分享文案，系统会自动提取第一个链接。";
      els.urlHint.classList.remove("ready");
    }
  }
  const cookiesFile = els.cookiesInput.files?.[0];
  els.cookiesField.classList.toggle("ready", Boolean(cookiesFile));
  const hasInput = mode === "url" ? Boolean(extractedUrl) : Boolean(els.fileInput.files?.[0]);
  els.submit.disabled = status === "running" || !hasInput;
}

async function readJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `请求失败 ${response.status}`);
  return json;
}

function friendlyError(message) {
  const text = String(message || "");
  if (/fresh cookies|cookies.*needed|login|登录|cookie/i.test(text)) {
    return "平台需要登录态或 fresh cookies，当前无法直接从链接下载。请切到“上传”，把视频保存到本地后上传解析。";
  }
  return text;
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = value;
  return td;
}

function renderShots(shots) {
  els.shotsBody.replaceChildren();
  els.frameGrid.replaceChildren();

  for (const shot of shots) {
    const tr = document.createElement("tr");
    tr.append(
      cell(`#${String(shot.idx).padStart(2, "0")}`),
      cell(fmtSeconds(shot.start)),
      cell(fmtSeconds(shot.end)),
      cell(fmtSeconds(shot.dur)),
      cell(fileName(shot.keyframeRel)),
    );
    els.shotsBody.append(tr);

    const figure = document.createElement("figure");
    figure.className = "frame";

    const img = document.createElement("img");
    img.alt = `镜头 ${shot.idx} 关键帧`;
    img.loading = "lazy";
    if (shot.keyframeRel) {
      img.src = rel(shot.keyframeRel);
      img.addEventListener("error", () => figure.classList.add("frame-missing"));
    } else {
      figure.classList.add("frame-missing");
    }

    const caption = document.createElement("figcaption");
    const idx = document.createElement("span");
    idx.textContent = `#${String(shot.idx).padStart(2, "0")}`;
    const time = document.createElement("span");
    time.textContent = `${fmtSeconds(shot.start)} - ${fmtSeconds(shot.end)}`;
    caption.append(idx, time);

    figure.append(img, caption);

    // 画面描述（开了"画面描述"才有）
    const desc = shot.vlm;
    if (desc) {
      const body = document.createElement("div");
      body.className = "frame-desc";
      if (desc.summary) {
        const sum = document.createElement("p");
        sum.className = "fd-summary";
        sum.textContent = desc.summary;
        body.append(sum);
      }
      const metaLine = [desc.shotType, desc.angle].filter(Boolean).join(" / ");
      if (metaLine) {
        const m = document.createElement("p");
        m.className = "fd-meta";
        m.textContent = metaLine;
        body.append(m);
      }
      if (desc.product) {
        const p = document.createElement("p");
        p.className = "fd-tag";
        p.textContent = `带货主体：${desc.product}`;
        body.append(p);
      }
      if (desc.onScreenText) {
        const t = document.createElement("p");
        t.className = "fd-text";
        t.textContent = `画面文字：${desc.onScreenText}`;
        body.append(t);
      }
      figure.append(body);
    }

    // 台词（开了"台词听写"才有）
    if (shot.dialogue) {
      const dlg = document.createElement("p");
      dlg.className = "frame-dialogue";
      dlg.textContent = `台词：${shot.dialogue}`;
      figure.append(dlg);
    }

    els.frameGrid.append(figure);
  }
}

function renderResult(result) {
  lastResult = result;
  const info = result.imported.info || {};
  const meta = result.parsed.meta || {};
  const shots = result.parsed.shots || [];
  const title = info.title || fileName(result.imported.videoPath);
  const source = info.extractor || result.imported.kind;

  setText(els.title, title);
  setText(els.subtitle, `${source} · ${fileName(result.imported.videoPath)}`);
  setText(els.statDuration, fmtSeconds(meta.duration));
  setText(els.statSize, `${meta.width || "-"}×${meta.height || "-"}`);
  setText(els.statFps, meta.fps ? `${meta.fps}fps` : "-");
  setText(els.statShots, result.parsed.shotCount);
  setText(els.cutCount, `${result.parsed.cutCount} 个切点`);
  setText(els.frameCount, `${result.parsed.shotCount} 张`);
  renderShots(shots);

  els.empty.classList.add("hidden");
  els.result.classList.remove("hidden");

  // Step2 入口提示：没勾画面描述时复刻质量差
  const hasVlm = (result.parsed.shots || []).some((s) => s.vlm);
  setText(
    els.step2Sub,
    hasVlm
      ? "传你的产品图，把这条片复刻成你的带货视频"
      : "提示：上一步没勾「画面描述」，复刻质量会差，建议回上面勾上重新解析"
  );
  els.step2Submit.disabled = !(els.refInput.files && els.refInput.files.length);
}

// 把分镜数量/描述/听写这几个公共参数塞进请求（FormData 与 JSON 两种载体）
function commonParams() {
  return {
    shots: els.shotsInput.value || "",
    describe: els.describeInput.checked ? "1" : "0",
    transcribe: els.transcribeInput.checked ? "1" : "0",
  };
}

async function submit(event) {
  event.preventDefault();
  setError("");
  const slow = els.describeInput.checked || els.transcribeInput.checked;
  setStatus("running", slow ? "正在切镜头 + 画面描述/台词听写（可能 1-2 分钟）" : "正在下载/导入并切镜头");
  els.result.classList.add("hidden");
  els.empty.classList.remove("hidden");

  try {
    const common = commonParams();
    let json;
    if (mode === "url") {
      const extractedUrl = extractFirstHttpUrl(els.urlInput.value);
      const cookiesFile = els.cookiesInput.files?.[0];
      let response;
      if (cookiesFile) {
        const body = new FormData();
        body.append("url", extractedUrl);
        body.append("threshold", els.threshold.value);
        body.append("minShotDur", els.minShot.value);
        body.append("cookies", cookiesFile);
        for (const [k, v] of Object.entries(common)) body.append(k, v);
        response = await fetch("api/parse-url-with-cookies", { method: "POST", body });
      } else {
        response = await fetch("api/parse-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: extractedUrl,
            threshold: els.threshold.value,
            minShotDur: els.minShot.value,
            ...common,
          }),
        });
      }
      json = await readJson(response);
    } else {
      const file = els.fileInput.files?.[0];
      const body = new FormData();
      body.append("video", file);
      body.append("threshold", els.threshold.value);
      body.append("minShotDur", els.minShot.value);
      for (const [k, v] of Object.entries(common)) body.append(k, v);
      const response = await fetch("api/parse-upload", { method: "POST", body });
      json = await readJson(response);
    }

    renderResult(json);
    setStatus("done", "解析完成");
  } catch (err) {
    setError(friendlyError(err instanceof Error ? err.message : String(err)));
    setStatus("error", "解析失败");
  }
}

// ===== Step2 复刻洗稿 =====
function setStep2Status(next, message) {
  els.step2Status.className = `status-line ${next}`;
  els.step2Status.classList.remove("hidden");
  setText(els.step2StatusText, message);
  els.step2Submit.classList.toggle("running", next === "running");
  setText(els.step2Label, next === "running" ? "复刻中…" : "开始复刻（每镜约 60 秒）");
  const hasRefs = Boolean(els.refInput.files && els.refInput.files.length);
  els.step2Submit.disabled = next === "running" || !hasRefs;
}

function setStep2Error(message) {
  if (!message) {
    els.step2Error.classList.add("hidden");
    setText(els.step2Error, "");
    return;
  }
  setText(els.step2Error, message);
  els.step2Error.classList.remove("hidden");
}

function updateRefPreview() {
  const files = [...(els.refInput.files || [])].slice(0, 3);
  setText(els.refName, files.length ? `已选 ${files.length} 张产品图` : "选择产品参考图（1-3 张）");
  els.refPreview.replaceChildren();
  for (const f of files) {
    const img = document.createElement("img");
    img.className = "ref-thumb";
    img.src = URL.createObjectURL(f);
    img.addEventListener("load", () => URL.revokeObjectURL(img.src));
    els.refPreview.append(img);
  }
  els.step2Submit.disabled = !files.length;
}

function renderStep2(json) {
  els.step2Grid.replaceChildren();
  for (const s of json.shots || []) {
    const figure = document.createElement("figure");
    figure.className = "frame";

    const img = document.createElement("img");
    img.alt = `镜头 ${s.idx} 复刻图`;
    img.loading = "lazy";
    if (s.newImageRel) {
      img.src = rel(s.newImageRel);
      img.addEventListener("error", () => figure.classList.add("frame-missing"));
    } else {
      figure.classList.add("frame-missing");
    }

    const caption = document.createElement("figcaption");
    const idx = document.createElement("span");
    idx.textContent = `#${String(s.idx).padStart(2, "0")}`;
    const tag = document.createElement("span");
    tag.textContent = s.imageOk ? "新图" : "出图失败";
    caption.append(idx, tag);
    figure.append(img, caption);

    if (s.newSummary) {
      const body = document.createElement("div");
      body.className = "frame-desc";
      const p = document.createElement("p");
      p.className = "fd-summary";
      p.textContent = s.newSummary;
      body.append(p);
      figure.append(body);
    }
    if (s.newDialogue) {
      const d = document.createElement("p");
      d.className = "frame-dialogue";
      d.textContent = `新台词：${s.newDialogue}`;
      figure.append(d);
    }
    if (!s.imageOk && s.imageError) {
      const e = document.createElement("p");
      e.className = "frame-dialogue";
      e.textContent = `⚠ ${s.imageError}`;
      figure.append(e);
    }
    els.step2Grid.append(figure);
  }
}

async function submitStep2(event) {
  event.preventDefault();
  if (!lastResult) {
    setStep2Error("请先在上面解析一个视频");
    return;
  }
  const files = [...(els.refInput.files || [])].slice(0, 3);
  if (!files.length) {
    setStep2Error("请先选择产品参考图");
    return;
  }
  setStep2Error("");
  setStep2Status("running", "正在洗稿 + 出图（每镜约 60 秒，请耐心等）");
  els.step2Grid.replaceChildren();

  try {
    const body = new FormData();
    for (const f of files) body.append("refs", f);
    body.append(
      "payload",
      JSON.stringify({
        shots: lastResult.parsed.shots,
        meta: lastResult.parsed.meta,
        product: els.productInput.value || "",
        requirement: els.requirementInput.value || "",
        limit: els.limitInput.value || "",
      })
    );
    const response = await fetch("api/step2", { method: "POST", body });
    const json = await readJson(response);
    if (!json.ok) throw new Error(json.error || (json.stage === "rewrite" ? "洗稿失败" : "复刻失败"));
    renderStep2(json);
    const okCount = (json.shots || []).filter((s) => s.imageOk).length;
    setStep2Status("done", `复刻完成：${okCount} 镜出图`);
  } catch (err) {
    setStep2Error(err instanceof Error ? err.message : String(err));
    setStep2Status("error", "复刻失败");
  }
}

els.modeUrl.addEventListener("click", () => setMode("url"));
els.modeUpload.addEventListener("click", () => setMode("upload"));
els.urlInput.addEventListener("input", updateSubmit);
els.fileInput.addEventListener("change", () => {
  setText(els.fileName, els.fileInput.files?.[0]?.name || "选择视频文件");
  updateSubmit();
});
els.cookiesInput.addEventListener("change", () => {
  setText(els.cookiesName, els.cookiesInput.files?.[0]?.name || "cookies.txt（可选，给小红书等需登录平台用；抖音已免）");
  updateSubmit();
});
els.form.addEventListener("submit", submit);
els.refInput.addEventListener("change", updateRefPreview);
els.step2Form.addEventListener("submit", submitStep2);
setMode("url");
setStatus("idle", "等待视频输入");
