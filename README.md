# PromptToolkit

> English | [中文](README_zh.md)

ComfyUI custom nodes: prompt panel with an AI bridge, watermark compositing, signature pad, text signature, resolution master, and tag utilities.

## Nodes

### Prompt Panel

A positive-prompt holder with a draggable floating panel for quick editing without navigating the graph. Also participates in the AI bridge (below): its text is readable and writable over HTTP.

### AI Image Output

Publishes each image to the local AI bridge so an AI harness can retrieve generation results. Files behave like the core PreviewImage node: they land in the **temp directory** (wiped on every ComfyUI start) as a full-res PNG plus a Lanczos-downscaled JPEG preview (max side 1024) — the harness reads the small preview to save tokens. Only the newest 50 bridge images are kept; older ones are deleted as new ones arrive. Use your own save node for permanent archiving.

### AI Bridge (HTTP API for AI agents)

A lightweight bridge that lets a local AI harness (pi, Claude Code, scripts, …) drive ComfyUI with plain HTTP — no MCP server required. Routes are registered directly on the ComfyUI server:

| Route | Purpose |
| --- | --- |
| `GET /pt/ai/prompt` | All registered PromptPanel texts `{node_id: text}` |
| `GET /pt/ai/prompt/{node_id}` | One node's prompt text |
| `POST /pt/ai/prompt/set` | Set a PromptPanel's text; the on-screen widget updates live via websocket (`{node_id, positive}`) |
| `POST /pt/ai/prompt/update` | Frontend → backend sync (used by the page, not by harnesses) |
| `GET /pt/ai/resolution` | All registered Resolution Master states `{node_id: {width, height, batch_size, ...}}` |
| `GET /pt/ai/resolution/{node_id}` | One node's resolution state |
| `POST /pt/ai/resolution/set` | Set width/height/batch_size/latent_type/rescale_* on a Resolution Master; the on-screen node updates live via websocket |
| `POST /pt/ai/resolution/update` | Frontend → backend sync (used by the page, not by harnesses) |
| `POST /pt/ai/queue` | Ask the frontend to press Queue (multi-tab safe: only the focused tab queues) |
| `GET /pt/ai/image/latest?limit=N` | Newest files from AI Image Output nodes (`abs_path` + `preview_path`) |
| `GET /pt/ai/image/raw?index=N` | Raw bytes of a published image (0 = newest) |

The frontend (`web/ai_bridge.js`) pushes PromptPanel / ResolutionMasterPT widget values to the backend every ~1.5 s, and listens for the websocket events `pt_ai_set_prompt` / `pt_ai_set_resolution` / `pt_ai_queue`. A browser tab with the graph must be open for widget sync and queueing. ResolutionMasterPT nodes additionally register their executed state at run time, so the last-used dimensions are readable even with no browser open.

Example flow for an agent: read prompt → `POST /pt/ai/prompt/set` → `POST /pt/ai/resolution/set` → `POST /pt/ai/queue` → poll `GET /pt/ai/image/latest` → read the file from `preview_path` (compressed) or `abs_path` (full-res).

#### pi extension (`pi-extension/comfyui-bridge.ts`)

This repo doubles as a [pi package](https://github.com/earendil-works/pi): the `pi-extension/` folder holds a pi extension that wraps the bridge as agent tools (`comfyui_get_prompt`, `comfyui_set_prompt`, `comfyui_get_resolution`, `comfyui_set_resolution`, `comfyui_queue`, `comfyui_get_latest_image`). Install it with:

```bash
pi install git:github.com/saltysalrua/PromptToolkit   # any machine
pi install D:/Code/comfyui/PromptToolkit              # or a local clone
```

Set `COMFYUI_URL` if ComfyUI is not on `http://127.0.0.1:8188`.

### Replace Tags

Find-and-replace tags inside prompt text, with whole-word matching that respects comma-delimited tags and multi-word phrases.

### Apply Watermark

Composite a transparent PNG watermark onto images with position, scale, opacity, and adaptive color mode (auto contrast / black / white / original).

### Save Image (Strip Tags)

Save images with optional watermark compositing and metadata stripping. Supports `%date:...%`, `%NodeTitle.widget%`, `%seed%`, `%model%`, `%pprompt` / `%nprompt` filename macros, and writes Civitai-compatible A1111 metadata (model/lora hashes).

### Signature Pad

Hand-drawn signature on a canvas widget. Outputs `IMAGE` + `MASK` (Load Image convention), ready to feed into watermark nodes.

### Text Signature

Type text, pick a font (built-in or import your own `.ttf`/`.otf`/`.woff`), and render a transparent signature image. Outputs `IMAGE` + `MASK`.

### Resolution Master

Visual 2D resolution picker: drag on the pad (64-multiple snapping) or type dimensions, with a searchable preset library (SDXL, Flux, WAN, etc.). Emits width, height, rescale factor, batch size and an empty latent. Compatible with Nodes 2.0 (Vue) and legacy canvas. Its widget state is readable/writable through the AI bridge.

## Compatibility

- ComfyUI frontend >= 1.33.9 (Nodes 2.0 Vue mode supported)
- Uses `addDOMWidget` for all interactive UI — no build step required

## Install

Copy the `PromptToolkit` folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
