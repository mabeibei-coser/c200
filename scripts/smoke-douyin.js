// 冒烟：验证「抖音链接 → 浏览器拦截 CDN 直链 → 下载到本地」整条通道。
// 用法：npm run smoke:douyin -- "https://v.douyin.com/xxxxx/"
//   或直接贴分享文案：npm run smoke:douyin -- "0.56 复制打开抖音…… https://v.douyin.com/xxxxx/"
import { extractFirstHttpUrl } from "../lib/videoImport.js";
import { isDouyinUrl, downloadDouyinViaBrowser } from "../lib/douyinBrowser.js";

const raw = process.argv.slice(2).join(" ").trim();
if (!raw) {
  console.error('需要传入抖音链接：npm run smoke:douyin -- "<链接或分享文案>"');
  process.exit(1);
}

const url = extractFirstHttpUrl(raw) || raw;
console.log("[smoke] 解析出链接:", url);
console.log("[smoke] 是否抖音域名:", isDouyinUrl(url));
if (!isDouyinUrl(url)) {
  console.error("[smoke] 不是抖音链接，这条不走浏览器通道。");
  process.exit(1);
}

const t0 = Date.now();
try {
  const r = await downloadDouyinViaBrowser(url, {});
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[smoke] ✅ 成功", `(${secs}s)`);
  console.log("  状态:", r.status);
  console.log("  文件:", r.videoPath);
  console.log("  大小:", r.info.bytes ? (r.info.bytes / 1024 / 1024).toFixed(1) + " MB" : "(已存在,未重下)");
  console.log("  标题:", r.info.title || "(未取到)");
} catch (e) {
  console.error("[smoke] ❌ 失败:", e.message);
  process.exit(1);
}
