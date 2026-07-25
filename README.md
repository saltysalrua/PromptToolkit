# PromptToolkit

ComfyUI custom nodes: prompt panel with an AI bridge, watermark compositing, signature pad, text signature, resolution master, and tag utilities.

## Nodes

### Prompt Panel

A positive-prompt holder with a draggable floating panel for quick editing without navigating the graph. Also participates in the AI bridge (below): its text is readable and writable over HTTP.

### AI Image Output

Saves images (like a slim SaveImage with UI preview) and publishes each file to the local AI bridge so an AI harness can retrieve generation results.

### AI Bridge (HTTP API for AI agents)

A lightweight bridge that lets a local AI harness (pi, Claude Code, scripts, …) drive ComfyUI with plain HTTP — no MCP server required. Routes are registered directly on the ComfyUI server:

| Route | Purpose |
| --- | --- |
| `GET /pt/ai/prompt` | All registered PromptPanel texts `{node_id: text}` |
| `GET /pt/ai/prompt/{node_id}` | One node's prompt text |
| `POST /pt/ai/prompt/set` | Set a PromptPanel's text; the on-screen widget updates live via websocket (`{node_id, positive}`) |
| `POST /pt/ai/prompt/update` | Frontend → backend sync (used by the page, not by harnesses) |
| `POST /pt/ai/queue` | Ask the frontend to press Queue |
| `GET /pt/ai/image/latest?limit=N` | Newest files from AI Image Output nodes (includes `abs_path`) |
| `GET /pt/ai/image/raw?index=N` | Raw bytes of a published image (0 = newest) |

The frontend (`web/ai_bridge.js`) pushes PromptPanel values to the backend every ~1.5 s, and listens for the websocket events `pt_ai_set_prompt` / `pt_ai_queue`. A browser tab with the graph must be open for widget sync and queueing.

Example flow for an agent: read prompt → `POST /pt/ai/prompt/set` → `POST /pt/ai/queue` → poll `GET /pt/ai/image/latest` → read the file from `abs_path`.

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

Visual 2D resolution selector with 64-multiple snapping, aspect ratio presets, rescale modes (manual / target P / target MP), and a preset library (SDXL, Flux, WAN, etc.). Compatible with Nodes 2.0 (Vue) and legacy canvas.

## Compatibility

- ComfyUI frontend >= 1.33.9 (Nodes 2.0 Vue mode supported)
- Uses `addDOMWidget` for all interactive UI — no build step required

## Install

Copy the `PromptToolkit` folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
