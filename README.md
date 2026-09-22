# 🧁 IconBake

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/abaoa/IconBake)](https://github.com/abaoa/IconBake/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/abaoa/IconBake)
[![Language](https://img.shields.io/badge/language-TypeScript%20%2F%20Rust-blue.svg)](https://github.com/abaoa/IconBake)
[![开源](https://img.shields.io/badge/abaoa%2FIconBake-开源-green.svg)](https://github.com/abaoa/IconBake)

> 把图片（SVG / PNG）烘焙成图标字体 —— **纯前端**，完全在浏览器中运行。
> 可部署到任意静态托管，可打包成小巧的桌面应用，并已开源。

IconBake 把每张上传的图片变成一个图标字体的字形（glyph）。它会产出一个
`.zip`，内含字体文件（`.ttf` + `.woff`）、一份 CSS、一个独立的预览 HTML，
以及一份「名称 → 码位」的 JSON 映射 —— 无需服务器、无需上传、无需外部字体后端。

## 功能
- **SVG** 输入：直接当作矢量轮廓使用（质量最佳）。
- **PNG / JPG** 输入：通过 `imagetracerjs` 描摹成单色剪影。
- **在浏览器内构建字体**：使用 `opentype.js`（生成 TTF）+ `ttf2woff`（生成 WOFF）。
- 每个图标自动归一化到 1000em 的正方形，并翻转为字体坐标，保证每个字形居中、一致。
- 码位从 PUA 私有区 `E001` 开始递增。

## 工作原理

```
图片（svg / png）
   │
   ├─ svg  ──► 提取路径 extractSvgPaths()   ─┐
   │                                         ├─► 合并后的路径 data（d 属性）
   └─ png  ──► 位图描摹 tracePng()          ─┘
                     │
                     ▼
        解析路径 → 归一化（包围盒→1000em，y 轴翻转）→ opentype.Path
                     │
                     ▼
            opentype.Font → TTF → ttf2woff → WOFF
                     │
                     ▼
        JSZip：字体 + CSS + 预览 demo.html + JSON 映射  →  下载
```

## 开发

```bash
npm install
npm run dev        # 本地开发，访问 http://localhost:5173
npm run build      # 构建出静态站点 dist/
npm run preview    # 预览生产构建
```

## 部署（静态站点）

`dist/` 是一个纯静态站点，可放到 Vercel / Netlify / Cloudflare Pages /
GitHub Pages / 任意静态服务器上。项目已包含 `vercel.json`：

```bash
vercel --prod      # 或在 Vercel 后台连接本仓库
```

若要嵌入到现有站点（例如 `abaoa.cn`），构建后把 `dist/` 放到子路径下，
或挂到一个子域名。

## 桌面应用（Tauri，仅几 MB）

```bash
npx tauri icon 图标路径/icon.png       # 生成 src-tauri/icons/* 全套图标
python scripts/build-desktop.py        # 构建前端 + 编译原生可执行文件
python scripts/build-desktop.py --skip-web   # 前端产物已最新时，只编译 exe
```

与 Electron 不同，Tauri 生成的可执行文件只有几 MB，因为它复用系统的
WebView，不打包 Chromium，也不打包 FontForge 后端。

> **发布前请用 `scripts/build-desktop.py` 编译**，而不是直接 `cargo build`。
> Rust 会把源码的绝对路径编进二进制（panic 位置等），直接编译会让产物里带上
> 构建机的用户名和目录结构（`%USERPROFILE%\.cargo\registry\...`）。
> 该脚本在调用 cargo 时注入 `--remap-path-prefix`，把这些路径统一替换成
> `/build/...`，并在编译后自动自检产物中是否还有本机路径。


## 开源

```bash
git clone https://github.com/abaoa/IconBake.git
cd IconBake
git remote add origin https://github.com/abaoa/IconBake.git
git push -u origin master
```

仓库地址：https://github.com/abaoa/IconBake

## 限制
- 图标字体天生是**单色**的。多色图案建议改用 SVG sprite，而不是字体。
- PNG 描摹得到的是单色剪影；为获得最佳效果，优先使用 SVG 输入。
- 本版（MVP）未生成 WOFF2（只生成 TTF + WOFF），后续可通过 `wawoff2` 补上。

## 许可证
MIT
