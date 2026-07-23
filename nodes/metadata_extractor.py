"""Extract A1111-style generation parameters from a ComfyUI prompt graph.

ComfyUI passes the full graph to output nodes as the hidden ``prompt``
input: ``{node_id: {"class_type": str, "inputs": {...}}}``. Input
values are either literals or ``[node_id, output_index]`` references.

This module walks that graph to collect the common generation fields
(positive/negative prompt, steps, sampler, scheduler, cfg, seed, size,
checkpoint, loras). It only handles the widespread built-in node types
(KSampler*, CLIPTextEncode, CheckpointLoaderSimple, LoraLoader,
EmptyLatentImage, PrimitiveNode) and degrades gracefully: anything it
cannot resolve is simply omitted, so exotic graphs still save an image
with whatever metadata could be recovered.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any

import folder_paths  # type: ignore

logger = logging.getLogger(__name__)

# Cache: file path -> short SHA256 hash (first 10 hex chars), matching
# the A1111 "Model hash" convention that Civitai uses for resource linking.
_hash_cache: dict[str, str] = {}

# Node class types we recognise. Kept as sets so lookups are cheap and
# so adding aliases is trivial.
SAMPLER_TYPES = {
    "KSampler",
    "KSamplerAdvanced",
    "KSamplerEfficient",
    "KSamplerSelect",
    "SamplerCustom",
}

TEXT_ENCODE_TYPES = {
    "CLIPTextEncode",
    "CLIPTextEncodeSDXL",
    "CLIPTextEncodeSDXLRefiner",
    "T5TextEncode",
    "NVEmbed",
}

EMPTY_LATENT_TYPES = {
    "EmptyLatentImage",
    "EmptySD3LatentImage",
    "EmptyHunyuanLatentVideo",
    "EmptyLatentImageAdvanced",
}


def _is_ref(value: Any) -> bool:
    """True if ``value`` is a ``[node_id, output_index]`` reference."""
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)


def _follow(prompt: dict, value: Any) -> tuple[str | None, dict | None]:
    """If ``value`` is a reference, return ``(node_id, node_dict)``."""
    if _is_ref(value):
        node_id = value[0]
        return node_id, prompt.get(node_id)
    return None, None


def _resolve_literal(prompt: dict, value: Any, *, field: str) -> Any:
    """Resolve a value that may be a literal or a PrimitiveNode ref.

    ComfyUI primitives surface as a reference to a ``PrimitiveNode``
    whose actual value lives in ``inputs[field]`` (often ``"value"``).
    """
    if _is_ref(value):
        _, node = _follow(prompt, value)
        if node is None:
            return None
        inputs = node.get("inputs", {})
        if field in inputs:
            return _resolve_literal(prompt, inputs[field], field=field)
        # PrimitiveNode convention
        if "value" in inputs:
            return _resolve_literal(prompt, inputs["value"], field=field)
        if "seed" in inputs:
            return _resolve_literal(prompt, inputs["seed"], field=field)
        return None
    return value


def _resolve_text(prompt: dict, value: Any, depth: int = 0) -> str:
    """Resolve a prompt-text value, following references up to a limit."""
    if depth > 8:
        return ""
    if isinstance(value, str):
        return value
    if _is_ref(value):
        _, node = _follow(prompt, value)
        if node is None:
            return ""
        inputs = node.get("inputs", {})
        # CLIPTextEncode and friends carry the literal on ``text``.
        for key in ("text", "text_pos", "text_neg", "string", "value"):
            if key in inputs:
                resolved = _resolve_text(prompt, inputs[key], depth=depth + 1)
                if resolved:
                    return resolved
        return ""
    return ""


# Input names that carry a model filename on loader nodes (class-agnostic).
_CKPT_INPUT_NAMES = ("ckpt_name", "unet_name", "gguf_name", "model_name", "model_path")
_LORA_SINGLE_INPUTS = ("lora_name", "lora")


def _strip_model_name(name: str) -> str:
    """Basename without extension - the A1111/Civitai convention for both
    ``<lora:name:weight>`` tags and hash lookups."""
    if not name:
        return name
    return os.path.splitext(os.path.basename(name))[0]


def _extract_loras_from_inputs(inputs: dict) -> list[tuple[str, float]]:
    """Collect ``(name, strength)`` from a node's widget inputs regardless of
    its class. Covers the standard LoraLoader (``lora_name``), LoraManager's
    stack loader (``loras`` list of dicts), rgthree Power Lora Loader
    (``lora_1``..``lora_N`` dicts), Efficient/LoraStack (``lora_stack``
    tuples) and anything else exposing the same input shapes.
    """
    out: list[tuple[str, float]] = []
    # 1) single lora_name / lora literal
    for key in _LORA_SINGLE_INPUTS:
        v = inputs.get(key)
        if isinstance(v, str) and v:
            strength = inputs.get("strength_model", inputs.get("strength", 1.0))
            sf = _coerce_float(strength)
            out.append((_strip_model_name(v), sf if sf is not None else 1.0))
    # 2) lora_stack: list of [path, model_strength, clip_strength]
    ls = inputs.get("lora_stack")
    if isinstance(ls, list):
        for item in ls:
            if (
                isinstance(item, (list, tuple))
                and len(item) >= 2
                and isinstance(item[0], str)
                and item[0]
            ):
                sf = _coerce_float(item[1])
                out.append((_strip_model_name(item[0]), sf if sf is not None else 1.0))
    # 3) LoraManager stack: "loras" = list of {name, strength, active, ...}
    #    (possibly wrapped in {"__value__": [...]}).
    lv = inputs.get("loras")
    if isinstance(lv, dict) and "__value__" in lv:
        lv = lv["__value__"]
    if isinstance(lv, list):
        for d in lv:
            if not isinstance(d, dict):
                continue
            if not d.get("active", True) or d.get("_isDummy", False):
                continue
            nm = d.get("name")
            if not isinstance(nm, str) or not nm:
                continue
            sf = _coerce_float(d.get("strength", 1.0))
            out.append((_strip_model_name(nm), sf if sf is not None else 1.0))
    # 4) rgthree Power Lora Loader: lora_1, lora_2, ... = {on, lora, strength}
    for key, value in inputs.items():
        if not key.lower().startswith("lora_"):
            continue
        if not isinstance(value, dict):
            continue
        if not value.get("on") or not value.get("lora"):
            continue
        sf = _coerce_float(value.get("strength", 1.0))
        out.append((_strip_model_name(value["lora"]), sf if sf is not None else 1.0))
    return out


def _collect_loras(
    prompt: dict,
    value: Any,
    node_loras: list[list[tuple[str, float]]],
    depth: int = 0,
) -> None:
    """Walk the sampler's ``model`` input chain toward the checkpoint,
    collecting each node's LoRAs (by input shape, not class name) into
    ``node_loras`` as one sublist per node in walk (sampler->base) order.
    The caller flattens with reversed() to get base-first ordering while
    preserving each node's internal lora order.
    """
    if depth > 16:
        return
    _, node = _follow(prompt, value)
    if node is None:
        return
    inputs = node.get("inputs", {})
    sub = _extract_loras_from_inputs(inputs)
    if sub:
        node_loras.append(sub)
    # Base model loader (loads from file, no upstream model): stop walking.
    if any(isinstance(inputs.get(k), str) and inputs.get(k) for k in _CKPT_INPUT_NAMES):
        return
    if "model" in inputs:
        _collect_loras(prompt, inputs["model"], node_loras, depth=depth + 1)


def _find_sampler(prompt: dict) -> tuple[str, dict] | None:
    """Pick the sampler node that produced this image.

    Strategy: prefer a *terminal* sampler - one whose latent output is
    not fed into another sampler's ``latent_image`` - that also feeds a
    VAE Decode. This correctly handles hires-fix / two-stage graphs
    where a base sampler's latent is consumed by a refiner sampler: the
    refiner is terminal, the base is not. Falls back to the last sampler
    in graph order.
    """
    sampler_ids = [
        nid for nid, node in prompt.items() if node.get("class_type") in SAMPLER_TYPES
    ]
    if not sampler_ids:
        return None

    # Samplers whose latent is consumed as another sampler's latent_image
    # are upstream stages - not the one that produced the final image.
    upstream: set[str] = set()
    for node in prompt.values():
        if node.get("class_type") not in SAMPLER_TYPES:
            continue
        latent_in = node.get("inputs", {}).get("latent_image")
        if _is_ref(latent_in) and latent_in[0] in sampler_ids:
            upstream.add(latent_in[0])

    decode_consumers = {"VAEDecode", "VAEDecodeTiled"}

    def _feeds_decode(nid: str) -> bool:
        for other in prompt.values():
            if other.get("class_type") not in decode_consumers:
                continue
            for inp in other.get("inputs", {}).values():
                if _is_ref(inp) and inp[0] == nid:
                    return True
        return False

    # 1) terminal sampler that feeds a decode - the ideal pick.
    for nid in sampler_ids:
        if nid in upstream:
            continue
        if _feeds_decode(nid):
            return nid, prompt[nid]
    # 2) any sampler that feeds a decode (no terminal one found).
    for nid in sampler_ids:
        if _feeds_decode(nid):
            return nid, prompt[nid]
    # 3) last resort: last sampler in graph order.
    return sampler_ids[-1], prompt[sampler_ids[-1]]


def _coerce_int(value: Any) -> int | None:
    """Best-effort int coercion; returns ``None`` on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_float(value: Any) -> float | None:
    """Best-effort float coercion; returns ``None`` on failure."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _find_size(prompt: dict, sampler_node: dict | None) -> str | None:
    """Determine output size ``WxH`` from an empty-latent node."""
    candidates: list[dict] = []
    if sampler_node is not None:
        latent_in = sampler_node.get("inputs", {}).get("latent_image")
        _, latent_node = _follow(prompt, latent_in)
        if latent_node and latent_node.get("class_type") in EMPTY_LATENT_TYPES:
            candidates.append(latent_node)
    if not candidates:
        for node in prompt.values():
            if node.get("class_type") in EMPTY_LATENT_TYPES:
                candidates.append(node)
    for node in candidates:
        inputs = node.get("inputs", {})
        w = _resolve_literal(prompt, inputs.get("width"), field="width")
        h = _resolve_literal(prompt, inputs.get("height"), field="height")
        wv = _coerce_int(w)
        hv = _coerce_int(h)
        if wv is not None and hv is not None:
            return f"{wv}x{hv}"
        # Some nodes use ``image_width``/``image_height``.
        wv = _coerce_int(inputs.get("image_width"))
        hv = _coerce_int(inputs.get("image_height"))
        if wv is not None and hv is not None:
            return f"{wv}x{hv}"
    return None


# Friendly sampler/scheduler name mapping, mirroring lora-manager.
_SAMPLER_MAP = {
    "euler": "Euler",
    "euler_ancestral": "Euler a",
    "dpm_2": "DPM2",
    "dpm_2_ancestral": "DPM2 a",
    "heun": "Heun",
    "dpm_fast": "DPM fast",
    "dpm_adaptive": "DPM adaptive",
    "lms": "LMS",
    "dpmpp_2s_ancestral": "DPM++ 2S a",
    "dpmpp_sde": "DPM++ SDE",
    "dpmpp_sde_gpu": "DPM++ SDE",
    "dpmpp_2m": "DPM++ 2M",
    "dpmpp_2m_sde": "DPM++ 2M SDE",
    "dpmpp_2m_sde_gpu": "DPM++ 2M SDE",
    "ddim": "DDIM",
}
# Maps ComfyUI scheduler names to A1111-friendly labels, matching
# LoraManager's convention so Civitai parses the Sampler field correctly.
_SCHEDULER_MAP = {
    "normal": "Simple",
    "simple": "Simple",
    "karras": "Karras",
    "exponential": "Exponential",
    "sgm_uniform": "SGM Uniform",
    "sgm_quadratic": "SGM Quadratic",
}


def extract_metadata(prompt: dict | None) -> dict[str, Any]:
    """Extract a metadata dict from a ComfyUI prompt graph."""
    meta: dict[str, Any] = {}
    if not prompt:
        return meta

    sampler = _find_sampler(prompt)
    sampler_node = sampler[1] if sampler else None
    if sampler_node is not None:
        inputs = sampler_node.get("inputs", {})
        steps = _resolve_literal(prompt, inputs.get("steps"), field="steps")
        steps_v = _coerce_int(steps)
        if steps_v is not None:
            meta["steps"] = steps_v
        # CFG / guidance — Flux and some newer models use "guidance"
        # instead of "cfg"; collect both so format_parameters can pick.
        cfg = _resolve_literal(prompt, inputs.get("cfg"), field="cfg")
        if cfg is None:
            cfg = _resolve_literal(prompt, inputs.get("cfg_scale"), field="cfg_scale")
        cfg_v = _coerce_float(cfg)
        if cfg_v is not None:
            meta["cfg"] = cfg_v
        guidance = _resolve_literal(prompt, inputs.get("guidance"), field="guidance")
        guidance_v = _coerce_float(guidance)
        if guidance_v is not None:
            meta["guidance"] = guidance_v
        seed = _resolve_literal(prompt, inputs.get("seed"), field="seed")
        if seed is None:
            seed = _resolve_literal(
                prompt, inputs.get("noise_seed"), field="noise_seed"
            )
        if seed is not None:
            meta["seed"] = str(seed)
        sampler_name = inputs.get("sampler_name")
        if isinstance(sampler_name, str):
            meta["sampler"] = _SAMPLER_MAP.get(sampler_name, sampler_name)
        scheduler = inputs.get("scheduler")
        if isinstance(scheduler, str):
            meta["scheduler"] = _SCHEDULER_MAP.get(scheduler, scheduler)

        # Prompts
        pos = _resolve_text(prompt, inputs.get("positive"))
        neg = _resolve_text(prompt, inputs.get("negative"))
        if pos:
            meta["prompt"] = pos
        if neg:
            meta["negative_prompt"] = neg

        # Model / LoRA chain
        node_loras: list[list[tuple[str, float]]] = []
        model_in = inputs.get("model")
        _collect_loras(prompt, model_in, node_loras)
        # node_loras is in sampler->base order; reverse for base-first
        # ordering (matching LoraManager / A1111) while keeping each node's
        # internal lora order intact.
        loras = [lora for sub in reversed(node_loras) for lora in sub]
        if not loras:
            # Fallback: scan every node for lora inputs. Catches loaders
            # that sit off the model chain (e.g. clip-only lora routing).
            seen: set[str] = set()
            for nd in prompt.values():
                if not isinstance(nd, dict):
                    continue
                for nm, st in _extract_loras_from_inputs(nd.get("inputs", {})):
                    if nm not in seen:
                        seen.add(nm)
                        loras.append((nm, st))
        if loras:
            meta["loras"] = loras
        # Walk past loras to find the checkpoint name.
        cur = model_in
        for _ in range(16):
            _, node = _follow(prompt, cur)
            if node is None:
                break
            cin = node.get("inputs", {})
            name = None
            for k in _CKPT_INPUT_NAMES:
                v = cin.get(k)
                if isinstance(v, str) and v:
                    name = v
                    break
            if name:
                meta["checkpoint"] = name
                break
            cur = cin.get("model")
            if cur is None:
                break

    size = _find_size(prompt, sampler_node)
    if size:
        meta["size"] = size

    return meta


def _calc_short_hash(file_path: str) -> str | None:
    """Return the first 10 hex chars of a file's SHA256, or None on error."""
    if not file_path or not os.path.isfile(file_path):
        return None
    if file_path in _hash_cache:
        return _hash_cache[file_path]
    try:
        sha = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 16), b""):
                sha.update(chunk)
        short = sha.hexdigest()[:10]
        _hash_cache[file_path] = short
        return short
    except OSError as exc:
        logger.warning("Failed to hash %s: %s", file_path, exc)
        return None


_filename_list_cache: dict[str, list[str]] = {}


def _get_filename_list(folder_type: str) -> list[str]:
    names = _filename_list_cache.get(folder_type)
    if names is None:
        try:
            names = list(folder_paths.get_filename_list(folder_type))
        except Exception:
            names = []
        _filename_list_cache[folder_type] = names
    return names


def _find_model_file(folder_types: list[str], name: str) -> str | None:
    """Resolve a model file path from a name that may be a bare basename, a
    basename with extension, or a relative subfolder path.

    Tries ``folder_paths.get_full_path`` first, then falls back to matching
    the basename-without-extension against the registered file list. This is
    needed because LoraManager's stack loader stores stripped names (no ext,
    no subfolder) and because loras live in subfolders - a bare filename does
    not resolve via get_full_path in either case.
    """
    if not name:
        return None
    stripped = _strip_model_name(name)
    for ft in folder_types:
        try:
            p = folder_paths.get_full_path(ft, name)
        except Exception:
            p = None
        if p and os.path.isfile(p):
            return p
        for rel in _get_filename_list(ft):
            if _strip_model_name(rel) == stripped:
                try:
                    p = folder_paths.get_full_path(ft, rel)
                except Exception:
                    p = None
                if p and os.path.isfile(p):
                    return p
    return None


def _get_checkpoint_hash(checkpoint_name: str) -> str | None:
    """Get the short SHA256 hash for a checkpoint or unet file."""
    path = _find_model_file(
        ["checkpoints", "unet", "diffusion_models"], checkpoint_name
    )
    return _calc_short_hash(path) if path else None


def _get_lora_hash(lora_name: str) -> str | None:
    """Get the short SHA256 hash for a LoRA file."""
    path = _find_model_file(["loras"], lora_name)
    return _calc_short_hash(path) if path else None


def format_parameters(meta: dict[str, Any]) -> str:
    """Render a metadata dict as an A1111-style ``parameters`` string.

    The output follows the AUTOMATIC1111 convention so that Civitai can
    auto-detect generation parameters and link resources via hashes::

        positive prompt
        <lora:name:weight> ...
        Negative prompt: negative prompt
        Steps: 20, Sampler: Euler a Karras, CFG scale: 7, Seed: 12345,
        Size: 512x512, Model hash: abc123def4, Model: checkpoint_name,
        Lora hashes: "lora1: hash1, lora2: hash2"
    """
    if not meta:
        return ""

    parts: list[str] = []
    prompt = meta.get("prompt", "")
    loras = meta.get("loras") or []

    if loras:
        lora_tags = [f"<lora:{name}:{strength}>" for name, strength in loras]
        prompt_line = (
            f"{prompt}\n{' '.join(lora_tags)}" if prompt else " ".join(lora_tags)
        )
    else:
        prompt_line = prompt
    parts.append(prompt_line)

    neg = meta.get("negative_prompt", "")
    if neg:
        parts.append(f"Negative prompt: {neg}")

    params: list[str] = []
    if "steps" in meta:
        params.append(f"Steps: {meta['steps']}")
    sampler = meta.get("sampler")
    scheduler = meta.get("scheduler")
    if sampler and scheduler:
        params.append(f"Sampler: {sampler} {scheduler}")
    elif sampler:
        params.append(f"Sampler: {sampler}")
    # CFG scale — prefer guidance (Flux) over cfg_scale over cfg,
    # matching LoraManager's priority order.
    cfg_val = meta.get("guidance")
    if cfg_val is None:
        cfg_val = meta.get("cfg_scale")
    if cfg_val is None:
        cfg_val = meta.get("cfg")
    if cfg_val is not None:
        params.append(f"CFG scale: {cfg_val}")
    if "seed" in meta:
        params.append(f"Seed: {meta['seed']}")
    if "size" in meta:
        params.append(f"Size: {meta['size']}")
    if "checkpoint" in meta:
        ckpt_raw = str(meta["checkpoint"])
        ckpt = os.path.splitext(os.path.basename(ckpt_raw))[0]
        ckpt_hash = _get_checkpoint_hash(ckpt_raw)
        if ckpt_hash:
            params.append(f"Model hash: {ckpt_hash}, Model: {ckpt}")
        else:
            params.append(f"Model: {ckpt}")
    # Lora hashes: "name1: hash1, name2: hash2"
    if loras:
        lora_hash_parts: list[str] = []
        for name, _strength in loras:
            h = _get_lora_hash(name)
            if h:
                lora_hash_parts.append(f"{name}: {h}")
        if lora_hash_parts:
            params.append(f'Lora hashes: "{", ".join(lora_hash_parts)}"')
    if params:
        parts.append(", ".join(params))
    return "\n".join(parts)
