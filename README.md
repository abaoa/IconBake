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
- **界面布局**：左侧常驻「图标库」栏（导入 + 卡片网格，独立滚动），右侧画布用标签页收纳「字体预览 / 字体信息 / 字体文件预览」，顶部常驻保存 / 打开 / 烘焙操作栏；左右栏之间可拖拽调整宽度，窗口大小自适应；900px 以下响应式变为单列。
- **SVG** 输入：**描边（stroke）与填充（fill）都能正确还原**。
  Lucide / Feather / Tabler 这类 `fill="none" stroke="currentColor"` 的描边图标，
  会先用几何偏移把描边展开成真实轮廓再入字体 —— 否则只会填充描边的中心线。
- **PNG / JPG** 输入：通过 `imagetracerjs` 描摹成单色剪影。
- **在浏览器内构建字体**：使用 `opentype.js`（生成 TTF）+ `ttf2woff`（生成 WOFF）。
- 每个图标自动归一化到 1000em 的正方形，并翻转为字体坐标，保证每个字形居中、一致。
- **图标顺序可调**：拖动卡片，或用卡片上的 ← → 按钮；顺序决定码位分配。
- **起始码位可设**：默认从 PUA 私有区 `E001` 开始，可改成任意十六进制值。
- **项目文件**：把当前图标与设置存成 `.iconbake.json`，下次一键打开继续做；
  编辑过程也会自动暂存在浏览器里，刷新不丢。
- **字体预览**：把待生成的字体真的构建一遍并注册给浏览器，用**真实字体渲染**展示出来 ——
  看到的就是安装后的效果。可切换字号、一键复制全部字符，排版示例行能直接看出
  图标与文字是否落在同一基线上（列表里的缩略图画的是原始路径，看不出这些）。
- **字体信息可自定义**：字体名、样式名、版本、版权、设计者（含链接）、制造商（含链接）、
  许可（含链接）、描述都会写进字体的 `name` 表，安装后能被系统字体管理器与设计软件读到；
  完整名称与 PostScript 名会实时派生显示，留空的字段不会写入。
- **字体文件预览（外部文件）**：打开磁盘上任一 `.ttf` / `.otf` / `.woff` / `.woff2`，
  把里面的图标字形列出来看 —— 既能看别人的图标字体里有什么，也能核对刚导出的产物。
  默认只显示 PUA 私有区码位（图标字体的惯例），可切到全部码位、按字形名或码位搜索、
  切字号、点击复制单个字符；支持 Material 那类「敲 `home` 出图标」的连字字体（会识别
  并列出 liga 连字）；读得到字形名就显示名字，读不到（不少商业字体如此）就用 `#序号` 兜底。
  WOFF2 用 Brotli 压缩、浏览器外的 JS 解不开，此时降级为「只能试排文字」，不影响渲染。

## 工作原理

```
图片（svg / png）
   │
   ├─ svg  ──► 解析样式与变换（继承 / style / transform）
   │            ├─ 描边图形 ──► 几何偏移展开为轮廓（Clipper）
   │            └─ 填充图形 ──► 直接使用原始路径
   │                                         ├─► 填充就绪的路径 data（d 属性）
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
- 导出物虽然叫 `.ttf`，但 `opentype.js` 写的是 **OTTO/CFF** 容器 —— 系统与浏览器都照常
  安装、加载，只是「字体文件预览」面板会如实标成 `OTF`，别被扩展名和标记不一致吓到。
- 字体文件预览里读不出 WOFF2 的字形清单（Brotli 压缩），只能试排文字。

## 许可证
MIT
