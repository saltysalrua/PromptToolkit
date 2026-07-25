"""Resolution Master - a Nodes 2.0 compatible port of Comfyui-Resolution-Master.

Same input/output contract as the original ResolutionMaster node (mode,
latent_type, width, height, auto_detect, rescale_mode, rescale_value,
batch_size, optional input_image), so the semantics are familiar. The
interactive UI lives in web/resolution_master.js (DOM widget, works in
both the legacy canvas renderer and Nodes 2.0).

Rescale semantics mirror the original frontend:
- manual:      rescale_value IS the factor
- resolution:  rescale_value is the target "P" (e.g. 1080); the frontend
               computes factor = sqrt((P*16/9*P) / (w*h))
- megapixels:  rescale_value is the target MP; factor = sqrt(MP*1e6 / (w*h))
The computed factor is stored in the rescale_value widget by the UI.
"""

from __future__ import annotations

import logging
from typing import Any

import comfy.model_management  # type: ignore[import-not-found]
import torch  # type: ignore[import-not-found]  # provided by the ComfyUI runtime

from .ai_bridge import register_resolution

logger = logging.getLogger(__name__)


class ResolutionMasterPT:
    """Pick width/height visually and emit dims, rescale factor and latent."""

    NAME = "Resolution Master"
    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "Visual resolution picker (Nodes 2.0 compatible port of Resolution "
        "Master): drag on the pad or choose a preset; outputs width, height, "
        "rescale factor, batch size and an empty latent."
    )

    def __init__(self):
        self.device = comfy.model_management.intermediate_device()

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "mode": (
                    ["Manual", "Manual Sliders", "Common Resolutions", "Aspect Ratios"],
                ),
                "latent_type": (
                    ["latent_4x8", "latent_128x16"],
                    {"default": "latent_4x8"},
                ),
                "width": ("INT", {"default": 1024, "min": 0, "max": 32768, "step": 64}),
                "height": (
                    "INT",
                    {"default": 1024, "min": 0, "max": 32768, "step": 64},
                ),
                "auto_detect": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "Auto-detect from input",
                        "label_off": "Manual",
                    },
                ),
                "rescale_mode": ("STRING", {"default": "manual"}),
                "rescale_value": (
                    "FLOAT",
                    {"default": 1.0, "step": 0.001, "min": 0.0, "max": 100.0},
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "tooltip": "The number of latent images in the batch.",
                    },
                ),
            },
            "optional": {
                "input_image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT", "INT", "FLOAT", "INT", "LATENT")
    RETURN_NAMES = ("width", "height", "rescale_factor", "batch_size", "latent")
    FUNCTION = "main"

    def main(
        self,
        mode,
        latent_type,
        width,
        height,
        auto_detect,
        rescale_mode,
        rescale_value,
        batch_size=1,
        input_image=None,
        unique_id=None,
    ):
        # Auto-detect dimensions from a connected image, unless the widgets
        # were set to different values manually (manual wins).
        if auto_detect and input_image is not None:
            try:
                if input_image.dim() == 4:  # [batch, height, width, channels]
                    detected_height = int(input_image.shape[1])
                    detected_width = int(input_image.shape[2])
                elif input_image.dim() == 3:  # [height, width, channels]
                    detected_height = int(input_image.shape[0])
                    detected_width = int(input_image.shape[1])
                else:
                    detected_width = detected_height = 0

                if detected_width and detected_height:
                    if width == detected_width and height == detected_height:
                        width, height = detected_width, detected_height
                        logger.info(
                            "[ResolutionMasterPT] Using auto-detected dimensions: %sx%s",
                            width,
                            height,
                        )
                    else:
                        logger.info(
                            "[ResolutionMasterPT] Using manual dimensions: %sx%s (detected: %sx%s)",
                            width,
                            height,
                            detected_width,
                            detected_height,
                        )
            except (RuntimeError, TypeError) as e:
                logger.warning("[ResolutionMasterPT] Error detecting dimensions: %s", e)

        rescale_factor = rescale_value

        # Publish the executed state to the AI bridge so a harness can read
        # it back even when no browser tab is pushing widget syncs.
        register_resolution(
            unique_id,
            {
                "width": width,
                "height": height,
                "batch_size": batch_size,
                "mode": mode,
                "latent_type": latent_type,
                "auto_detect": bool(auto_detect),
                "rescale_mode": rescale_mode,
                "rescale_value": rescale_factor,
            },
        )

        if latent_type == "latent_128x16":
            # Flux 2 uses 128 channels and divides by 16
            latent = torch.zeros(
                [batch_size, 128, height // 16, width // 16], device=self.device
            )
        else:
            # SD1.5/SDXL uses 4 channels and divides by 8
            latent = torch.zeros(
                [batch_size, 4, height // 8, width // 8], device=self.device
            )

        return (width, height, rescale_factor, batch_size, {"samples": latent})
