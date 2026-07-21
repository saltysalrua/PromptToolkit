# PromptToolkit

ComfyUI custom nodes: watermark compositing, signature pad, text signature, and resolution master.

## Nodes

### Apply Watermark

Composite a transparent PNG watermark onto images with position, scale, opacity, and adaptive color mode (auto contrast / black / white / original).

### Save Image (Strip Tags)

Save images with optional watermark compositing and metadata stripping. Supports `%date:...%` and `%NodeTitle.widget%` filename macros.

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
