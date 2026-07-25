# PromptToolkit

> [English](README.md) | 中文

ComfyUI 自定义节点合集：带 AI 桥的提示词面板、水印合成、签名板、文字签名、分辨率大师，以及标签工具。

## 节点

### Prompt Panel（提示词面板）

正面提示词持有节点，带一个可拖拽的浮动面板，不用在图里滚来滚去就能快速编辑。同时接入了 AI 桥（见下文）：它的文本可以通过 HTTP 读取和写入。

### AI Image Output（AI 图像输出）

把每张图发布到本地 AI 桥，让 AI 代理（harness）能取回生成结果。文件行为与官方 PreviewImage 节点一致：写入 **temp 临时目录**（每次 ComfyUI 启动时清空），包含一张全尺寸 PNG 和一张 Lanczos 降采样 JPEG 预览（最长边 1024）——harness 读小预览以节省 token。桥图片最多保留最近 50 张，更旧的会在新图到达时自动删除。需要永久存档请使用你自己的保存节点。

### AI Bridge（给 AI 代理用的 HTTP API）

一座轻量的桥，让本地 AI 代理（pi、Claude Code、脚本……）用纯 HTTP 驱动 ComfyUI——不需要 MCP 服务器。路由直接注册在 ComfyUI 服务器上：

| 路由 | 用途 |
| --- | --- |
| `GET /pt/ai/prompt` | 所有已注册 PromptPanel 的文本 `{node_id: text}` |
| `GET /pt/ai/prompt/{node_id}` | 单个节点的提示词文本 |
| `POST /pt/ai/prompt/set` | 设置 PromptPanel 文本；界面上的控件通过 websocket 实时更新（`{node_id, positive}`） |
| `POST /pt/ai/prompt/update` | 前端 → 后端同步（页面自用，harness 别调） |
| `GET /pt/ai/resolution` | 所有已注册 Resolution Master 的状态 `{node_id: {width, height, batch_size, ...}}` |
| `GET /pt/ai/resolution/{node_id}` | 单个节点的分辨率状态 |
| `POST /pt/ai/resolution/set` | 设置 Resolution Master 的 width/height/batch_size/latent_type/rescale_*；界面节点通过 websocket 实时更新 |
| `POST /pt/ai/resolution/update` | 前端 → 后端同步（页面自用，harness 别调） |
| `POST /pt/ai/queue` | 让前端按下队列按钮（多标签页安全：只有获得焦点的标签页会执行） |
| `GET /pt/ai/image/latest?limit=N` | AI Image Output 节点的最新文件（`abs_path` + `preview_path`） |
| `GET /pt/ai/image/raw?index=N` | 直接返回已发布图片的原始字节（0 = 最新） |

前端（`web/ai_bridge.js`）每约 1.5 秒把 PromptPanel / ResolutionMasterPT 的控件值推送给后端，并监听 websocket 事件 `pt_ai_set_prompt` / `pt_ai_set_resolution` / `pt_ai_queue`。控件同步和队列触发都要求有一个打开着该图的浏览器标签页。ResolutionMasterPT 节点在每次执行时还会注册实际生效的状态，所以即使没开浏览器也能读到上次使用的尺寸。

代理的典型流程：读提示词 → `POST /pt/ai/prompt/set` → `POST /pt/ai/resolution/set` → `POST /pt/ai/queue` → 轮询 `GET /pt/ai/image/latest` → 从 `preview_path`（压缩图）或 `abs_path`（全尺寸）读取文件。

#### pi 扩展（`pi-extension/comfyui-bridge.ts`）

本仓库同时是一个 [pi 包](https://github.com/earendil-works/pi)：`pi-extension/` 目录里是一个 pi 扩展，把 AI 桥封装成代理工具（`comfyui_get_prompt`、`comfyui_set_prompt`、`comfyui_get_resolution`、`comfyui_set_resolution`、`comfyui_queue`、`comfyui_get_latest_image`）。安装方式：

```bash
pi install git:github.com/saltysalrua/PromptToolkit   # 任意机器
pi install D:/Code/comfyui/PromptToolkit              # 或者本地克隆
```

如果 ComfyUI 不在 `http://127.0.0.1:8188`，请设置环境变量 `COMFYUI_URL`。

### Replace Tags（替换标签）

在提示词文本中查找并替换标签，整词匹配逻辑尊重逗号分隔的标签语义和多词短语。

### Apply Watermark（应用水印）

把透明 PNG 水印合成到图像上，支持位置、缩放、不透明度，以及自适应颜色模式（自动反色 / 纯黑 / 纯白 / 原始颜色）。

### Save Image (Strip Tags)（保存图像·标签剥离）

保存图像，可选水印合成与元数据剥离。支持 `%date:...%`、`%NodeTitle.widget%`、`%seed%`、`%model%`、`%pprompt` / `%nprompt` 文件名宏，并写入 Civitai 兼容的 A1111 元数据（模型 / LoRA 哈希）。

### Signature Pad（签名板）

在画布控件上手写签名。按 Load Image 的惯例输出 `IMAGE` + `MASK`，可直接接入水印节点。

### Text Signature（文字签名）

输入文字、挑选字体（内置或导入你自己的 `.ttf`/`.otf`/`.woff`），渲染出透明签名图。输出 `IMAGE` + `MASK`。

### Resolution Master（分辨率大师）

可视化 2D 分辨率选择器：在手写板上拖拽（按 64 的倍数吸附）或直接输入尺寸，附带可搜索的预设库（SDXL、Flux、WAN 等）。输出宽度、高度、缩放系数、批大小和一个空 latent。兼容 Nodes 2.0（Vue）与旧版画布。其控件状态可通过 AI 桥读写。

## 兼容性

- ComfyUI 前端 >= 1.33.9（支持 Nodes 2.0 Vue 模式）
- 所有交互 UI 均使用 `addDOMWidget` 实现——无需构建步骤

## 安装

把 `PromptToolkit` 文件夹复制到 `ComfyUI/custom_nodes/` 并重启 ComfyUI。
