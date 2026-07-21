"""Save an image with generation metadata, with optional tag stripping.

Modeled on comfyui-lora-manager's Save Image node, but self-contained:
generation parameters are parsed from the ComfyUI prompt graph that
ComfyUI passes to every output node as the hidden ``prompt`` input, so
this node has no cross-plugin dependencies. Before writing the A1111-
style ``parameters`` block, any tags listed in ``exclude_tags`` are
removed from the positive and negative prompt text - handy for keeping
tags like ``loli`` out of the saved metadata.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
from typing import Any

import torch  # type: ignore[import-not-found]  # provided by the ComfyUI runtime
from PIL import PngImagePlugin

import folder_paths  # type: ignore

from .metadata_extractor import extract_metadata, format_parameters
from .tag_utils import parse_tag_list, scrub_object, strip_tags
from .watermark import (
    COLOR_MODES,
    POSITIONS_TOOLTIP,
    apply_mask,
    apply_watermark,
    pil_to_tensor,
    tensor_to_pil,
)

try:  # piexif is only needed for JPEG/WebP metadata; PNG does not need it.
    import piexif  # type: ignore[import-not-found]  # installed in the ComfyUI runtime
except ImportError:  # pragma: no cover - optional dependency
    piexif = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# Mirrors the frontend's applyTextReplacements() for filename_prefix, which
# only runs for core save nodes (SaveImage, SaveVideo, ...). Patterns:
#   %date:FORMAT%        - date tokens yyyy yy MM M dd d hh h mm m ss s
#   %Node Title.widget%  - widget value of a node in the prompt graph
#   %width% / %height%   - left intact; folder_paths handles them
_MACRO_RE = re.compile(r"%([^%]+)%")
_DATE_TOKEN_RE = re.compile(r"yyyy|yy|MM|M|dd|d|hh|h|mm|m|ss|s")


def _format_date(fmt: str, now) -> str:
    tokens = {
        "yyyy": f"{now.year}",
        "yy": f"{now.year % 100:02d}",
        "MM": f"{now.month:02d}",
        "M": f"{now.month}",
        "dd": f"{now.day:02d}",
        "d": f"{now.day}",
        "hh": f"{now.hour:02d}",
        "h": f"{now.hour}",
        "mm": f"{now.minute:02d}",
        "m": f"{now.minute}",
        "ss": f"{now.second:02d}",
        "s": f"{now.second}",
    }
    return _DATE_TOKEN_RE.sub(lambda match: tokens[match.group(0)], fmt)


def _resolve_node_widget(name: str, widget: str, prompt: dict | None) -> Any:
    """Find a widget value in the API prompt by class_type or node title."""
    if not isinstance(prompt, dict):
        return None
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == name or node.get("_meta", {}).get("title") == name:
            value = node.get("inputs", {}).get(widget)
            if value is None or isinstance(value, (list, dict)):
                return None  # link or missing: leave the pattern as-is
            if isinstance(value, bool):
                return "true" if value else "false"  # JS String(bool)
            if isinstance(value, float) and value.is_integer():
                return f"{value:.0f}"
            return str(value)
    return None


def expand_filename_prefix(prefix: str, prompt: dict | None) -> str:
    """Expand %...% macros the way the frontend does for core save nodes."""
    if "%" not in prefix:
        return prefix
    now = datetime.datetime.now()

    def repl(match: re.Match) -> str:
        inner = match.group(1)
        if inner.startswith("date:"):
            return _format_date(inner[5:], now)
        parts = inner.split(".")
        if len(parts) == 2:
            value = _resolve_node_widget(parts[0], parts[1], prompt)
            if value is not None:
                return value
            logger.warning("Unable to resolve filename macro %%%s%%", inner)
        return match.group(0)

    return _MACRO_RE.sub(repl, prefix)


class SaveImageStripTags:
    """Save an image with metadata, excluding chosen tags from the prompt."""

    NAME = "Save Image (Strip Tags)"
    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "Save images with embedded generation metadata, with specific "
        "tags (e.g. loli) removed from the prompt metadata."
    )

    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.prefix_append = ""
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "ComfyUI",
                        "tooltip": "Base filename for saved images.",
                    },
                ),
                "file_format": (
                    ["png", "jpeg", "webp"],
                    {
                        "tooltip": "Image format. PNG preserves quality; JPEG/WebP are smaller.",
                    },
                ),
                "exclude_tags": (
                    "STRING",
                    {
                        "default": "loli",
                        "multiline": True,
                        "tooltip": "Tags to remove from the saved prompt metadata, one per line or comma separated.",
                    },
                ),
            },
            "optional": {
                "use_regex": ("BOOLEAN", {"default": False}),
                "whole_word": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "Match tag boundaries so e.g. `cat` does not match `category`.",
                    },
                ),
                "case_sensitive": ("BOOLEAN", {"default": False}),
                "strip_from_negative": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "Also strip tags from the negative prompt.",
                    },
                ),
                "quality": (
                    "INT",
                    {
                        "default": 100,
                        "min": 1,
                        "max": 100,
                    },
                ),
                "lossless_webp": ("BOOLEAN", {"default": False}),
                "embed_workflow": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "Embed the full ComfyUI workflow JSON into the image. The excluded tags are scrubbed from the embedded workflow/prompt strings too.",
                    },
                ),
                "save_with_metadata": ("BOOLEAN", {"default": True}),
                "add_counter_to_filename": ("BOOLEAN", {"default": True}),
                "watermark": (
                    "IMAGE",
                    {
                        "tooltip": "Optional watermark image (e.g. a transparent PNG from Load Image) composited onto every saved image.",
                    },
                ),
                "watermark_mask": (
                    "MASK",
                    {
                        "tooltip": "Alpha channel of the watermark PNG: connect the MASK output of the same Load Image node, otherwise transparency is lost (Load Image drops alpha). The mask is inverted internally.",
                    },
                ),
                "watermark_pos_x": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": POSITIONS_TOOLTIP,
                    },
                ),
                "watermark_pos_y": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": POSITIONS_TOOLTIP,
                    },
                ),
                "watermark_scale": (
                    "FLOAT",
                    {
                        "default": 15.0,
                        "min": 1.0,
                        "max": 100.0,
                        "step": 0.5,
                        "tooltip": "Watermark width as a percentage of the image's short side. Only used when a watermark image is connected.",
                    },
                ),
                "watermark_opacity": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "Watermark opacity; multiplies the PNG's own alpha.",
                    },
                ),
                "watermark_margin": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 0.0,
                        "max": 50.0,
                        "step": 0.5,
                        "tooltip": "Edge margin as a percentage of the image's short side.",
                    },
                ),
                "watermark_color_mode": (
                    COLOR_MODES,
                    {
                        "default": "auto_contrast",
                        "tooltip": "auto_contrast: recolor the ink to black or white based on the background under the watermark (needs transparency, i.e. a connected mask). black/white: force the ink color. original: keep the watermark colors.",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True

    def _build_parameters(
        self,
        prompt_graph: dict | None,
        *,
        exclude_tags: str,
        use_regex: bool,
        whole_word: bool,
        case_sensitive: bool,
        strip_from_negative: bool,
    ) -> tuple[str, dict[str, Any]]:
        """Extract metadata, strip tags, return (parameters_str, raw_dict)."""
        meta = extract_metadata(prompt_graph)
        tags = parse_tag_list(exclude_tags)
        if tags:
            if meta.get("prompt"):
                meta["prompt"] = strip_tags(
                    meta["prompt"],
                    tags,
                    use_regex=use_regex,
                    whole_word=whole_word,
                    case_sensitive=case_sensitive,
                )
            if strip_from_negative and meta.get("negative_prompt"):
                meta["negative_prompt"] = strip_tags(
                    meta["negative_prompt"],
                    tags,
                    use_regex=use_regex,
                    whole_word=whole_word,
                    case_sensitive=case_sensitive,
                )
        return format_parameters(meta), meta

    def save_images(
        self,
        images,
        filename_prefix: str = "ComfyUI",
        file_format: str = "png",
        exclude_tags: str = "",
        use_regex: bool = False,
        whole_word: bool = True,
        case_sensitive: bool = False,
        strip_from_negative: bool = True,
        quality: int = 100,
        lossless_webp: bool = False,
        embed_workflow: bool = False,
        save_with_metadata: bool = True,
        add_counter_to_filename: bool = True,
        watermark_pos_x: float = 1.0,
        watermark_pos_y: float = 1.0,
        watermark_scale: float = 15.0,
        watermark_opacity: float = 0.8,
        watermark_margin: float = 2.0,
        watermark_color_mode: str = "auto_contrast",
        watermark=None,
        watermark_mask=None,
        prompt: dict | None = None,
        extra_pnginfo: dict | None = None,
    ) -> dict[str, Any]:
        parameters, _meta = self._build_parameters(
            prompt,
            exclude_tags=exclude_tags,
            use_regex=use_regex,
            whole_word=whole_word,
            case_sensitive=case_sensitive,
            strip_from_negative=strip_from_negative,
        )

        # When embedding the workflow, scrub the excluded tags from the
        # workflow / API-prompt JSON too, otherwise the stripped tags would
        # leak back out through the embedded metadata.
        tags = parse_tag_list(exclude_tags)
        scrubbed_extra: dict | None = None
        if extra_pnginfo is not None:
            if embed_workflow and tags:
                scrubbed_extra = {
                    key: scrub_object(
                        value,
                        tags,
                        use_regex=use_regex,
                        whole_word=whole_word,
                        case_sensitive=case_sensitive,
                    )
                    for key, value in extra_pnginfo.items()
                }
            else:
                scrubbed_extra = extra_pnginfo

        if (
            save_with_metadata
            and parameters
            and piexif is None
            and file_format in ("jpeg", "webp")
        ):
            logger.warning(
                "piexif not installed: %s metadata will be empty. "
                "Install piexif or save as PNG.",
                file_format.upper(),
            )

        filename_prefix = expand_filename_prefix(filename_prefix, prompt)

        full_output_folder, filename, counter, subfolder, _prefix = (
            folder_paths.get_save_image_path(
                filename_prefix,
                self.output_dir,
                images[0].shape[1],
                images[0].shape[0],
            )
        )

        results = []
        watermarked_frames = []
        wm_pil = None
        if watermark is not None:
            wm_pil = apply_mask(tensor_to_pil(watermark[0]), watermark_mask)
        for i, image in enumerate(images):
            img = tensor_to_pil(image)
            if wm_pil is not None:
                img = apply_watermark(
                    img,
                    wm_pil,
                    pos_x=watermark_pos_x,
                    pos_y=watermark_pos_y,
                    scale_percent=watermark_scale,
                    opacity=watermark_opacity,
                    margin_percent=watermark_margin,
                    color_mode=watermark_color_mode,
                )
            watermarked_frames.append(pil_to_tensor(img))

            base_filename = filename
            if add_counter_to_filename:
                base_filename += f"_{counter + i:05}_"
            elif len(images) > 1:
                # Counter disabled but batch > 1: still disambiguate so
                # images within the same run do not overwrite each other.
                base_filename += f"_{i:03d}_"

            save_kwargs: dict[str, Any] = {}
            pnginfo: PngImagePlugin.PngInfo | None = None

            if file_format == "png":
                file = base_filename + ".png"
                save_kwargs = {"compress_level": self.compress_level}
                if save_with_metadata or embed_workflow:
                    pnginfo = PngImagePlugin.PngInfo()
                    if save_with_metadata and parameters:
                        pnginfo.add_text("parameters", parameters)
                    if embed_workflow and scrubbed_extra is not None:
                        if "workflow" in scrubbed_extra:
                            pnginfo.add_text(
                                "workflow", json.dumps(scrubbed_extra["workflow"])
                            )
                        if "prompt" in scrubbed_extra:
                            pnginfo.add_text(
                                "prompt", json.dumps(scrubbed_extra["prompt"])
                            )
                    save_kwargs["pnginfo"] = pnginfo
                img.save(
                    os.path.join(full_output_folder, file), format="PNG", **save_kwargs
                )

            elif file_format == "jpeg":
                file = base_filename + ".jpg"
                # JPEG has no alpha channel; flatten RGBA/gray to RGB.
                if img.mode != "RGB":
                    img = img.convert("RGB")
                save_kwargs = {"quality": quality, "optimize": True}
                if save_with_metadata and parameters and piexif is not None:
                    try:
                        exif_dict = {
                            "Exif": {
                                piexif.ExifIFD.UserComment: b"UNICODE\0"
                                + parameters.encode("utf-16be")
                            }
                        }
                        save_kwargs["exif"] = piexif.dump(exif_dict)
                    except (ValueError, TypeError) as e:
                        logger.error("Error adding EXIF data: %s", e)
                img.save(
                    os.path.join(full_output_folder, file), format="JPEG", **save_kwargs
                )

            elif file_format == "webp":
                file = base_filename + ".webp"
                save_kwargs = {
                    "quality": quality,
                    "lossless": lossless_webp,
                    "method": 0,
                }
                if piexif is not None:
                    try:
                        exif_dict: dict[str, Any] = {}
                        if save_with_metadata and parameters:
                            exif_dict["Exif"] = {
                                piexif.ExifIFD.UserComment: b"UNICODE\0"
                                + parameters.encode("utf-16be")
                            }
                        if (
                            embed_workflow
                            and scrubbed_extra is not None
                            and "workflow" in scrubbed_extra
                        ):
                            exif_dict["0th"] = {
                                piexif.ImageIFD.ImageDescription: "Workflow:"
                                + json.dumps(scrubbed_extra["workflow"])
                            }
                        if exif_dict:
                            save_kwargs["exif"] = piexif.dump(exif_dict)
                    except (ValueError, TypeError) as e:
                        logger.error("Error adding EXIF data: %s", e)
                img.save(
                    os.path.join(full_output_folder, file), format="WEBP", **save_kwargs
                )

            else:
                raise ValueError(f"Unsupported file format: {file_format}")

            results.append(
                {"filename": file, "subfolder": subfolder, "type": self.type}
            )

        return {
            "result": (torch.cat(watermarked_frames, dim=0),),
            "ui": {"images": results},
        }
