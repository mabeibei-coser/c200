# C200 爆款视频复刻 (video-remake)

参考一条爆款视频的拍摄手法，把视频里的产品换成你自己的产品，复刻出同款带货视频（例：原片带货笔记本 → 复刻成带货你的笔）。

谁在用 / 用在哪：Shirley 的营销推广项目线（C 系列）。**本期只做前三步**——① 解析参考视频拆分镜 → ② 用 Image2(gpt-image-2) 生成产品参考图 → ③ 生成保持一致的分镜脚本；下游 ④图生视频 / ⑤拼接成片 由用户拿交付物手动接力。

## 怎么跑

```bash
npm install
cp .env.local.example .env.local    # 填 key：生图 BANANA_*、画面描述/文字 VLM_*（讯飞）、视频 VIDEO_*（选填）
npm run dev                         # 打开 http://127.0.0.1:3001/
npm run smoke:image                 # 冒烟：验证 gpt-image-2 能否图生图（换主体保构图）
npm run smoke:import                # 冒烟：验证“导入本地视频 → 精解析切镜头/抽帧”
npm run smoke:vlm                   # 冒烟：验证讯飞 vision（Qwen-VL）逐镜画面描述
npm run smoke:asr                   # 冒烟：验证本地 whisper 听写台词
npm run smoke:douyin -- "<抖音链接>"  # 冒烟：验证抖音链接 → 浏览器拦截 video_mp4 CDN 直链 → 下载
```

### 台词听写依赖（Python，本地离线）

台词用本地 `faster-whisper`（不联网、不花钱、不连云），需要本机有 Python 3.9+：

```bash
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple faster-whisper
```

模型首次自动下载到 `~/.cache/huggingface`（small ≈250MB），之后转写全程离线。要更准的地名/专名识别可换更大模型：`ASR_MODEL=medium`（≈1.5GB）。不需要台词就不用装这一步。

## 精解析视频

精解析默认先把视频落到本地，再用 ffmpeg 切镜头、抽关键帧，产物会写到 `data/parse-results/` 与 `data/frames/`：

```bash
npm run parse:input -- "https://example.com/video"
npm run parse:input -- "data/videos/demo.mp4"
# 一条龙：切镜头 + 抽关键帧 + 逐镜画面描述(讯飞 Qwen-VL) + 台词听写(本地whisper)
npm run parse:input -- "data/videos/demo.mp4" --describe --transcribe
```

加 `--describe` 给每个镜头补一段结构化画面描述（主体/景别/角度/光线/画面文字/可替换的带货主体），加 `--transcribe` 听写台词并按时间对齐到镜头。完整镜头表写到 `data/parse-results/<名>.shots.json`。

网页入口：
- 打开 `http://127.0.0.1:3001/`
- 粘贴视频链接，或上传本地视频
- 页面会显示镜头表、切点数量、视频元信息和关键帧
- 抖音链接默认走「真 Chrome 拦截」自动下载，免登录/免 cookies；其它平台（如小红书）提示登录态时，可在链接模式额外上传 `cookies.txt`

说明：
- URL 导入：抖音链接走「浏览器拦截 CDN 直链」（`playwright-core` 驱动 Chrome/Chromium，免登录/免 cookies）；其它平台走 `yt-dlp`。下载的视频都落到 `data/videos/imports/`。
- 抖音优先用 headless 浏览器拦截 `douyinvod.com` + `video_mp4`，失败时自动切到本机 Chrome 有头兜底；本机 Chrome 默认路径为 `C:\Program Files\Google\Chrome`，可用环境变量 `CHROME_PATH` 覆盖。私密/需登录的视频仍可能截不到，改用本地上传。
- 小红书等其它平台如被登录态/风控拦住，改用本地视频文件路径。
- 可调切镜头参数：`npm run parse:input -- "data/videos/demo.mp4" --threshold=0.25 --minShotDur=0.6`。
- `cookies.txt` 只做本次请求临时文件，服务端用完会删除；不要把 cookies 内容粘贴到聊天或代码里。

## 现状

Phase 2/4 V1 进行中。完整方案与进度见 plan：`D:\_workspace\.planning\2026-06-23-C200视频复刻.md`，审批版计划 `~/.claude/plans/c200-1-gleaming-robin.md`。

## 技术栈（规划）

Node + Express 后端 ｜ 静态网页工作台 ｜ 生图 gpt-image-2（BananaRouter）｜ 画面描述 讯飞 Qwen-VL ｜ 台词 本地 whisper ｜ 视频下载 yt-dlp + 抖音浏览器拦截（headless 优先，本机 Chrome 兜底）｜ 解析 ffmpeg ｜ 视频生成 火山 Seedance（Step3）｜ 分镜脚本结构化输出。
