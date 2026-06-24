# 本地离线听写 CLI：用 faster-whisper 把音频转成带时间戳的台词，JSON 打到 stdout。
# 给 lib/asr.js spawn 调用，不直接给人用。
# 用法: python scripts/asr_whisper.py <音频路径> [--model small] [--lang zh]
# 首次会下模型（默认走 hf-mirror 国内镜像）。

import os
# 关掉新版 hf-xet 后端——它在本机会报错，关掉走经典下载更稳
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# 静音 Windows 无 Developer Mode 的软链接告警（不影响功能，只是更费点盘）
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
# 模型默认从 huggingface.co 拉（本机有代理可直连；hf-mirror 与新版 hub 的 etag 头不兼容会报
# FileMetadataError，故不强制走镜像）。若哪天没代理又要镜像，外部设 HF_ENDPOINT 即可覆盖。
# 模型只在首次下载，之后缓存到 ~/.cache/huggingface，转写全程离线。

import sys
import json
import argparse

# Windows 控制台默认 gbk，强制 UTF-8 输出，保证 Node 能解析中文 JSON
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default=os.environ.get("ASR_MODEL", "small"))
    ap.add_argument("--lang", default=os.environ.get("ASR_LANG", "zh"))
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        print(json.dumps({"ok": False, "error": f"音频不存在: {args.audio}"}, ensure_ascii=False))
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"faster-whisper 未装好: {e}"}, ensure_ascii=False))
        sys.exit(1)

    try:
        # CPU + int8：无显卡也能跑，体积/速度均衡
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        lang = None if args.lang in ("", "auto") else args.lang
        segments, info = model.transcribe(args.audio, language=lang, vad_filter=True)

        segs = []
        for s in segments:
            segs.append({
                "start": round(float(s.start), 3),
                "end": round(float(s.end), 3),
                "text": (s.text or "").strip(),
            })

        result = {
            "ok": True,
            "model": args.model,
            "language": info.language,
            "languageProb": round(float(info.language_probability), 3),
            "duration": round(float(info.duration), 3),
            "text": "".join(s["text"] for s in segs).strip(),
            "segments": segs,
        }
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"转写失败: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
