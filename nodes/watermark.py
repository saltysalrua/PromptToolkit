"""Watermark compositing helpers and a standalone watermark node.

The core logic lives in :func:`apply_watermark` so both the standalone
``ApplyWatermark`` node and the save node (SaveImageStripTags) share one
implementation.

Positioning uses normalized coordinates: ``pos_x``/``pos_y`` in [0, 1]
map the watermark between the margins of the image, so (0, 0) is the
top-left corner, (1, 1) the bottom-right corner, and (0.5, 0.5) centers
the watermark. Sizing is relative to the image's short side, so the
watermark keeps a consistent visual weight across aspect ratios and
resolutions.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import torch  # type: ignore[import-not-found]  # provided by the ComfyUI runtime
from PIL import Image

# Pillow >= 9.1 moved the resample filters to Image.Resampling.
_LANCZOS = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)

POSITIONS_TOOLTIP = (
    "Normalized position: 0 = left/top edge, 1 = right/bottom edge. "
    "e.g. (0, 0) top-left, (1, 1) bottom-right, (0.5, 0.5) centered."
)


COLOR_MODES = ["original", "auto_contrast", "black", "white"]

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _recolor_for_contrast(
    wm: Image.Image, base: Image.Image, x: int, y: int, mode: str
) -> Image.Image:
    """Recolor the watermark ink for visibility against the background.

    The watermark's alpha (its shape) is preserved; only the RGB channels
    are replaced. ``auto_contrast`` picks black or white ink based on the
    alpha-weighted luminance of the covered region. Watermarks without
    real transparency are left untouched: recoloring them would just
    paint a solid rectangle.
    """
    if mode == "original":
        return wm
    alpha = np.asarray(wm.getchannel("A"), dtype=np.float32) / 255.0
    if alpha.size == 0 or np.min(alpha) >= 0.98:
        return wm
    if mode == "auto_contrast":
        region = (
            np.asarray(
                base.crop((x, y, x + wm.width, y + wm.height)).convert("RGB"),
                dtype=np.float32,
            )
            / 255.0
        )
        luma = region @ _LUMA
        weight = float(np.sum(alpha))
        mean = float(np.sum(luma * alpha) / weight) if weight > 0 else 0.5
        mode = "black" if mean > 0.5 else "white"
    ink = 0 if mode == "black" else 255
    solid = Image.new("RGBA", wm.size, (ink, ink, ink, 255))
    solid.putalpha(wm.getchannel("A"))
    return solid


def apply_watermark(
    base: Image.Image,
    watermark: Image.Image,
    *,
    pos_x: float = 1.0,
    pos_y: float = 1.0,
    scale_percent: float = 15.0,
    opacity: float = 0.8,
    margin_percent: float = 2.0,
    color_mode: str = "original",
) -> Image.Image:
    """Composite ``watermark`` onto ``base`` and return a new RGBA image.

    ``scale_percent`` is the watermark width as a percentage of the
    image's short side; ``margin_percent`` insets the placement area by
    that percentage of the short side. ``pos_x``/``pos_y`` in [0, 1]
    interpolate the watermark between the margins.
    """
    base = base.convert("RGBA")
    if scale_percent <= 0 or opacity <= 0:
        return base

    wm = watermark.convert("RGBA")
    width, height = base.size
    short_side = min(width, height)

    target_w = max(1, round(short_side * scale_percent / 100.0))
    target_h = max(1, round(wm.height * (target_w / wm.width)))
    if (target_w, target_h) != wm.size:
        wm = wm.resize((target_w, target_h), _LANCZOS)

    if opacity < 1.0:
        channels = np.array(wm)
        channels[..., 3] = (channels[..., 3] * opacity).astype(np.uint8)
        wm = Image.fromarray(channels, "RGBA")

    margin = round(short_side * margin_percent / 100.0)
    # Clamp the position and keep the watermark inside the image.
    px = min(max(pos_x, 0.0), 1.0)
    py = min(max(pos_y, 0.0), 1.0)
    x = margin + round(max(0, width - 2 * margin - wm.width) * px)
    y = margin + round(max(0, height - 2 * margin - wm.height) * py)

    wm = _recolor_for_contrast(wm, base, x, y, color_mode)

    out = base.copy()
    out.alpha_composite(wm, (x, y))
    return out


def tensor_to_pil(image: torch.Tensor) -> Image.Image:
    """Convert one ComfyUI IMAGE frame ([H, W, C], float 0..1) to PIL."""
    arr = 255.0 * image.cpu().numpy()
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def pil_to_tensor(img: Image.Image) -> torch.Tensor:
    """Convert a PIL image to a ComfyUI IMAGE frame ([1, H, W, C])."""
    arr = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def apply_mask(watermark: Image.Image, mask) -> Image.Image:
    """Use a ComfyUI MASK ([B,H,W] or [H,W], 0..1) as the watermark's alpha.

    Needed because Load Image drops the PNG alpha channel (IMAGE is RGB).
    Its MASK output carries that alpha but INVERTED (ComfyUI MASK
    convention: 1 = masked/transparent area), so it is flipped back here.
    """
    wm = watermark.convert("RGBA")
    if mask is None:
        return wm
    m = mask[0] if getattr(mask, "ndim", 0) == 3 else mask
    arr = np.clip((1.0 - m.cpu().numpy()) * 255.0, 0, 255).astype(np.uint8)
    alpha = Image.fromarray(arr, "L")
    if alpha.size != wm.size:
        alpha = alpha.resize(wm.size, _LANCZOS)
    wm.putalpha(alpha)
    return wm


class ApplyWatermark:
    """Composite a transparent PNG watermark onto an image batch."""

    NAME = "Apply Watermark"
    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "Overlay a watermark (e.g. a transparent PNG from Load Image) onto "
        "images. Size is relative to the short side so it adapts to any "
        "resolution and aspect ratio; position uses normalized coordinates "
        "(0:0 = top-left, 1:1 = bottom-right)."
    )

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "image": ("IMAGE",),
                "watermark": (
                    "IMAGE",
                    {"tooltip": "Watermark image, ideally a transparent PNG."},
                ),
                "pos_x": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": POSITIONS_TOOLTIP,
                    },
                ),
                "pos_y": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": POSITIONS_TOOLTIP,
                    },
                ),
                "scale_percent": (
                    "FLOAT",
                    {
                        "default": 15.0,
                        "min": 1.0,
                        "max": 100.0,
                        "step": 0.5,
                        "tooltip": "Watermark width as a percentage of the image's short side.",
                    },
                ),
                "opacity": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "Watermark opacity; multiplies the PNG's own alpha.",
                    },
                ),
                "margin_percent": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 0.0,
                        "max": 50.0,
                        "step": 0.5,
                        "tooltip": "Edge margin as a percentage of the image's short side.",
                    },
                ),
                "color_mode": (
                    COLOR_MODES,
                    {
                        "default": "auto_contrast",
                        "tooltip": "auto_contrast: recolor the ink to black or white based on the background under the watermark (needs transparency, i.e. a connected mask). black/white: force the ink color. original: keep the watermark colors.",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "Alpha channel of the watermark PNG: connect the MASK output of the same Load Image node, otherwise transparency is lost (Load Image drops alpha). The mask is inverted internally.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "apply"

    def apply(
        self,
        image: torch.Tensor,
        watermark: torch.Tensor,
        pos_x: float = 1.0,
        pos_y: float = 1.0,
        scale_percent: float = 15.0,
        opacity: float = 0.8,
        margin_percent: float = 2.0,
        color_mode: str = "auto_contrast",
        mask=None,
    ) -> tuple[torch.Tensor]:
        wm_pil = apply_mask(tensor_to_pil(watermark[0]), mask)
        frames = [
            pil_to_tensor(
                apply_watermark(
                    tensor_to_pil(frame),
                    wm_pil,
                    pos_x=pos_x,
                    pos_y=pos_y,
                    scale_percent=scale_percent,
                    opacity=opacity,
                    margin_percent=margin_percent,
                    color_mode=color_mode,
                )
            )
            for frame in image
        ]
        return (torch.cat(frames, dim=0),)
