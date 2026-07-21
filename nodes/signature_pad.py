"""Hand-drawn signature pad node.

The frontend widget (web/signature_pad.js) captures pen strokes on a
drawing canvas and stores them as a base64 PNG data URL in the hidden
``signature_data`` widget, so the signature serializes with the workflow.
Here we simply decode it and emit ComfyUI-native outputs:

- ``image``: RGB, transparent areas become black (same as Load Image).
- ``mask``: 1 - alpha, the Load Image MASK convention, so it can feed
  straight into the watermark inputs of ApplyWatermark / SaveImageStripTags.
"""

from __future__ import annotations

import base64
import io
import logging
from typing import Any

import numpy as np
import torch  # type: ignore[import-not-found]  # provided by the ComfyUI runtime
from PIL import Image

logger = logging.getLogger(__name__)


class SignaturePad:
    """Drawing pad that outputs the signature as IMAGE + MASK."""

    NAME = "Signature Pad"
    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "Draw a signature by hand; outputs the image plus its alpha as a "
        "mask (Load Image convention), ready for the watermark nodes."
    )

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "signature_data": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Signature strokes, managed by the pad UI. Do not edit by hand.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "render"

    def render(self, signature_data: str = "") -> tuple[torch.Tensor, torch.Tensor]:
        img = self._decode(signature_data)
        rgb = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
        alpha = np.asarray(img.getchannel("A")).astype(np.float32) / 255.0
        image = torch.from_numpy(rgb)[None, ...]
        mask = torch.from_numpy(1.0 - alpha)[None, ...]
        return (image, mask)

    @staticmethod
    def _decode(data: str) -> Image.Image:
        if data and "," in data:
            try:
                raw = base64.b64decode(data.split(",", 1)[1])
                return Image.open(io.BytesIO(raw)).convert("RGBA")
            except (ValueError, OSError) as e:
                logger.warning("SignaturePad: corrupt signature data ignored: %s", e)
        return Image.new("RGBA", (64, 64), (0, 0, 0, 0))


class TextSignature:
    """Render text as a transparent signature image; outputs IMAGE + MASK."""

    NAME = "Text Signature"
    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "Type text and pick a font to generate a transparent signature image; "
        "outputs image plus its alpha as a mask (Load Image convention), "
        "ready for the watermark nodes."
    )

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "text_sig_data": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Rendered text-signature PNG (data URL). Managed by the UI.",
                    },
                ),
                "text_sig_state": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Serialized UI state (text, font, size, color, etc.). Managed by the UI.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "render"

    def render(
        self, text_sig_data: str = "", text_sig_state: str = ""
    ) -> tuple[torch.Tensor, torch.Tensor]:
        img = SignaturePad._decode(text_sig_data)
        rgb = np.asarray(img.convert("RGB")).astype(np.float32) / 255.0
        alpha = np.asarray(img.getchannel("A")).astype(np.float32) / 255.0
        image = torch.from_numpy(rgb)[None, ...]
        mask = torch.from_numpy(1.0 - alpha)[None, ...]
        return (image, mask)
