"""HTTP bridge between PromptToolkit nodes and a local AI harness.

The MCP approach wraps ComfyUI behind an MCP server, which is clunky for
nodes that live inside the graph.  This module takes the direct route:
it registers plain HTTP routes on the ComfyUI server itself, so any AI
harness (pi, Claude Code, scripts, ...) can talk to the nodes with simple
HTTP calls:

    GET  /pt/ai/prompt              -> {"prompts": {node_id: positive}}
    GET  /pt/ai/prompt/{node_id}    -> {"node_id": ..., "positive": ...}
    POST /pt/ai/prompt/update       (frontend pushes widget value)
    POST /pt/ai/prompt/set          (harness sets a prompt; the frontend
                                     widget is updated live via websocket)
    GET  /pt/ai/resolution          -> {"resolutions": {node_id: state}}
    GET  /pt/ai/resolution/{node_id}-> {"node_id": ..., "state": {...}}
    POST /pt/ai/resolution/update   (frontend pushes widget state)
    POST /pt/ai/resolution/set      (harness sets width/height/...; the
                                     frontend widgets update live)
    GET  /pt/ai/image/latest        -> newest AIImageOutput files
    GET  /pt/ai/image/raw?index=0   -> raw bytes of a returned image
    POST /pt/ai/queue               -> asks the frontend to queue the graph

State is a tiny in-memory registry; the frontend is the source of truth
for prompt text (it pushes on change) and execution pushes are a
fallback for when no browser tab is open.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from typing import Any

import folder_paths  # type: ignore
import numpy as np  # type: ignore[import-not-found]
import torch  # type: ignore[import-not-found]
from aiohttp import web  # type: ignore[import-not-found]
from PIL import Image
from server import PromptServer  # type: ignore[import-not-found]

_log = logging.getLogger("PromptToolkit.ai_bridge")

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_prompts: dict[str, str] = {}  # node_id (str) -> positive prompt text
_resolutions: dict[str, dict[str, Any]] = {}  # node_id (str) -> widget state
_images: deque[dict[str, Any]] = deque(maxlen=50)  # newest last


def register_prompt(node_id: Any, positive: str) -> None:
    """Record the current prompt text for a PromptPanel node."""
    if node_id is None:
        return
    with _lock:
        _prompts[str(node_id)] = positive or ""


def register_resolution(node_id: Any, state: dict[str, Any]) -> None:
    """Record the current widget state of a ResolutionMasterPT node.

    ``state`` holds a subset of RESOLUTION_FIELDS (width, height,
    batch_size, mode, latent_type, auto_detect, rescale_mode,
    rescale_value).
    """
    if node_id is None or not isinstance(state, dict):
        return
    with _lock:
        _resolutions[str(node_id)] = dict(state)


def register_image(entry: dict[str, Any]) -> None:
    """Publish a saved image to the harness.

    The registry keeps only the newest ``maxlen`` entries; when an entry
    falls out, its files (full-res + preview) are deleted from disk so
    long sessions don't accumulate bridge images.
    """
    with _lock:
        evicted = _images[0] if len(_images) == _images.maxlen else None
        _images.append(entry)
    if evicted:
        for key in ("abs_path", "preview_path"):
            path = evicted.get(key)
            if path and os.path.isfile(path):
                try:
                    os.remove(path)
                except OSError as exc:
                    _log.debug("failed to prune bridge image %s: %s", path, exc)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

_routes = PromptServer.instance.routes


@_routes.get("/pt/ai/prompt")
async def _get_all_prompts(request: web.Request) -> web.Response:
    with _lock:
        data = dict(_prompts)
    return web.json_response({"prompts": data})


@_routes.get("/pt/ai/prompt/{node_id}")
async def _get_prompt(request: web.Request) -> web.Response:
    node_id = str(request.match_info["node_id"])
    with _lock:
        text = _prompts.get(node_id)
    if text is None:
        return web.json_response(
            {"error": f"no prompt registered for node {node_id}"}, status=404
        )
    return web.json_response({"node_id": node_id, "positive": text})


@_routes.post("/pt/ai/prompt/update")
async def _update_prompt(request: web.Request) -> web.Response:
    """Frontend -> backend: sync the widget value into the registry."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    register_prompt(body.get("node_id"), body.get("positive", ""))
    return web.json_response({"ok": True})


@_routes.post("/pt/ai/prompt/set")
async def _set_prompt(request: web.Request) -> web.Response:
    """Harness -> backend -> frontend: set a PromptPanel node's text.

    Updates the registry immediately (so a queue triggered before the
    frontend round-trip still sees the new text) and pushes a websocket
    event so the on-screen widget updates live.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    node_id = body.get("node_id")
    positive = body.get("positive", "")
    if node_id is None:
        return web.json_response({"error": "node_id is required"}, status=400)
    register_prompt(node_id, positive)
    PromptServer.instance.send_sync(
        "pt_ai_set_prompt", {"node_id": str(node_id), "positive": positive}
    )
    return web.json_response({"ok": True, "node_id": str(node_id)})


# Widget fields the bridge understands for ResolutionMasterPT nodes.
RESOLUTION_FIELDS = (
    "width",
    "height",
    "batch_size",
    "mode",
    "latent_type",
    "auto_detect",
    "rescale_mode",
    "rescale_value",
)


@_routes.get("/pt/ai/resolution")
async def _get_all_resolutions(request: web.Request) -> web.Response:
    with _lock:
        data = {k: dict(v) for k, v in _resolutions.items()}
    return web.json_response({"resolutions": data})


@_routes.get("/pt/ai/resolution/{node_id}")
async def _get_resolution(request: web.Request) -> web.Response:
    node_id = str(request.match_info["node_id"])
    with _lock:
        state = _resolutions.get(node_id)
    if state is None:
        return web.json_response(
            {"error": f"no resolution state registered for node {node_id}"},
            status=404,
        )
    return web.json_response({"node_id": node_id, "state": dict(state)})


@_routes.post("/pt/ai/resolution/update")
async def _update_resolution(request: web.Request) -> web.Response:
    """Frontend -> backend: sync the widget state into the registry."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    node_id = body.get("node_id")
    state = body.get("state")
    if node_id is None or not isinstance(state, dict):
        return web.json_response(
            {"error": "node_id and state are required"}, status=400
        )
    register_resolution(node_id, state)
    return web.json_response({"ok": True})


@_routes.post("/pt/ai/resolution/set")
async def _set_resolution(request: web.Request) -> web.Response:
    """Harness -> backend -> frontend: set a ResolutionMasterPT node's widgets.

    Merges the patch into the registry immediately (so a queue triggered
    before the frontend round-trip still sees the new values) and pushes
    a websocket event so the on-screen node updates live.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    node_id = body.get("node_id")
    if node_id is None:
        return web.json_response({"error": "node_id is required"}, status=400)
    patch = {k: body[k] for k in RESOLUTION_FIELDS if k in body and body[k] is not None}
    if not patch:
        return web.json_response(
            {
                "error": "no resolution fields given "
                f"(any of: {', '.join(RESOLUTION_FIELDS)})"
            },
            status=400,
        )
    with _lock:
        merged = dict(_resolutions.get(str(node_id), {}))
        merged.update(patch)
        _resolutions[str(node_id)] = merged
    PromptServer.instance.send_sync(
        "pt_ai_set_resolution", {"node_id": str(node_id), "state": patch}
    )
    return web.json_response({"ok": True, "node_id": str(node_id), "state": merged})


@_routes.get("/pt/ai/image/latest")
async def _latest_images(request: web.Request) -> web.Response:
    try:
        limit = int(request.rel_url.query.get("limit", "5"))
    except ValueError:
        limit = 5
    with _lock:
        items = list(_images)[-limit:][::-1]  # newest first
    return web.json_response({"images": items})


@_routes.get("/pt/ai/image/raw")
async def _raw_image(request: web.Request) -> web.Response:
    try:
        index = int(request.rel_url.query.get("index", "0"))
    except ValueError:
        index = 0
    with _lock:
        items = list(_images)[::-1]  # newest first
    if index < 0 or index >= len(items):
        return web.json_response({"error": "index out of range"}, status=404)
    path = items[index].get("abs_path")
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "file missing"}, status=404)
    return web.FileResponse(path)  # type: ignore[return-value]


@_routes.post("/pt/ai/queue")
async def _queue(request: web.Request) -> web.Response:
    """Ask the frontend to press the Queue button."""
    PromptServer.instance.send_sync("pt_ai_queue", {})
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# AI Image Output node
# ---------------------------------------------------------------------------

# Compressed preview settings: the harness only needs to *review* the image,
# so publish a Lanczos-downscaled JPEG next to the full-res PNG and hand the
# preview path to the harness (saves a lot of tokens on 2K+ outputs).
PREVIEW_MAX_SIDE = 1024
PREVIEW_JPEG_QUALITY = 85

try:
    _LANCZOS = Image.Resampling.LANCZOS  # Pillow >= 9.1
except AttributeError:  # pragma: no cover - very old Pillow
    _LANCZOS = Image.LANCZOS  # type: ignore[attr-defined]


def _save_preview(
    img: Image.Image, folder: str, filename: str, counter: int
) -> str | None:
    """Write a Lanczos-downscaled JPEG preview; return its path (or None)."""
    try:
        w, h = img.size
        scale = PREVIEW_MAX_SIDE / max(w, h)
        preview = (
            img.resize((max(1, round(w * scale)), max(1, round(h * scale))), _LANCZOS)
            if scale < 1.0
            else img
        )
        path = os.path.join(folder, f"{filename}_{counter:05}_preview.jpg")
        preview.convert("RGB").save(
            path, "JPEG", quality=PREVIEW_JPEG_QUALITY, optimize=True
        )
        return path
    except Exception:  # pragma: no cover - preview must never break saving
        _log.exception("failed to write preview JPEG")
        return None


class AIImageOutput:
    """Save images and expose them to the AI harness over HTTP.

    Works like a slim PreviewImage: files land in the TEMP directory
    (auto-cleaned every time ComfyUI starts) under the given prefix, a
    preview is shown in the UI, and each saved file is registered so the
    harness can fetch it via ``/pt/ai/image/latest`` (or read
    ``abs_path``/``preview_path`` directly when running locally). Only
    the newest 50 images are kept; older ones are deleted as new ones
    arrive. Permanent archiving is left to the user's own save nodes.
    """

    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "Publish images to the local AI bridge (/pt/ai/image/latest) so an "
        "AI harness can retrieve them. Files go to the temp dir (wiped on "
        "ComfyUI restart); only the newest 50 are kept."
    )

    def __init__(self) -> None:
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "Images to publish."}),
                "filename_prefix": (
                    "STRING",
                    {"default": "ai_bridge/pt", "tooltip": "Output path prefix."},
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True

    def save(
        self,
        images: torch.Tensor,
        filename_prefix: str = "ai_bridge/pt",
        unique_id: Any = None,
    ) -> dict[str, Any]:
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix,
            self.output_dir,
            images[0].shape[1],
            images[0].shape[0],
        )
        results = []
        for image in images:
            arr = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            file = f"{filename}_{counter:05}_.png"
            abs_path = os.path.join(full_folder, file)
            img.save(abs_path, compress_level=1)  # scratch file: speed > size
            preview_path = _save_preview(img, full_folder, filename, counter)
            register_image(
                {
                    "node_id": None if unique_id is None else str(unique_id),
                    "filename": file,
                    "subfolder": subfolder,
                    "type": self.type,
                    "abs_path": os.path.abspath(abs_path),
                    "preview_path": (
                        os.path.abspath(preview_path) if preview_path else None
                    ),
                    "time": time.time(),
                }
            )
            results.append(
                {"filename": file, "subfolder": subfolder, "type": self.type}
            )
            counter += 1
        return {"ui": {"images": results}}
