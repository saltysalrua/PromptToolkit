"""PromptToolkit - a collection of prompt utility nodes for ComfyUI."""

import logging as _logging

from .nodes.ai_bridge import AIImageOutput
from .nodes.prompt_panel import PromptPanel
from .nodes.replace_tags import ReplaceTagsNode
from .nodes.resolution_master import ResolutionMasterPT
from .nodes.save_image_strip import SaveImageStripTags
from .nodes.signature_pad import SignaturePad, TextSignature
from .nodes.watermark import ApplyWatermark

NODE_CLASS_MAPPINGS = {
    "PromptPanel": PromptPanel,
    "ReplaceTags": ReplaceTagsNode,
    "SaveImageStripTags": SaveImageStripTags,
    "ApplyWatermark": ApplyWatermark,
    "SignaturePad": SignaturePad,
    "TextSignature": TextSignature,
    "ResolutionMasterPT": ResolutionMasterPT,
    "AIImageOutput": AIImageOutput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptPanel": "Prompt Panel",
    "ReplaceTags": "Replace Tags",
    "SaveImageStripTags": "Save Image (Strip Tags)",
    "ApplyWatermark": "Apply Watermark",
    "SignaturePad": "Signature Pad",
    "TextSignature": "Text Signature",
    "ResolutionMasterPT": "Resolution Master",
    "AIImageOutput": "AI Image Output",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

# Frontend extension (visual watermark editor) served from ./web
WEB_DIRECTORY = "./web"


# Install the runtime prompt-capture hook (best-effort; must never break
# node loading). See nodes/metadata_hook.py for why this is needed.
try:
    from .nodes.metadata_hook import install as _install_runtime_hook

    _install_runtime_hook()
except Exception:  # pragma: no cover - defensive
    _logging.getLogger("PromptToolkit").exception(
        "Failed to install runtime prompt-capture hook; "
        "prompt metadata will use static extraction only."
    )
