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

import os
from typing import Any

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

CHECKPOINT_TYPES = {
    "CheckpointLoaderSimple",
    "CheckpointLoader",
    "UNETLoader",
    "UnetLoaderGGUF",
    "Load Diffusion Model",
}

LORA_TYPES = {
    "LoraLoader",
    "LoraLoaderModelOnly",
    "XLABatchLoraLoader",
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


def _collect_loras(
    prompt: dict, value: Any, acc: list[tuple[str, float]], depth: int = 0
) -> None:
    """Walk a model input chain collecting LoRAs until a checkpoint."""
    if depth > 16:
        return
    _, node = _follow(prompt, value)
    if node is None:
        return
    class_type = node.get("class_type", "")
    inputs = node.get("inputs", {})
    if class_type in LORA_TYPES:
        name = inputs.get("lora_name") or inputs.get("lora") or ""
        strength = inputs.get("strength_model", inputs.get("strength", 1.0))
        strength_f = _coerce_float(strength)
        if strength_f is None:
            strength_f = 1.0
        if name:
            acc.append((str(name), strength_f))
        # Keep walking toward the base model.
        if "model" in inputs:
            _collect_loras(prompt, inputs["model"], acc, depth=depth + 1)
    elif class_type in CHECKPOINT_TYPES:
        # Base checkpoint reached; recorded by the caller separately.
        return
    else:
        # Pass-through node (e.g. LoraStackCombiner) - follow its model.
        if "model" in inputs:
            _collect_loras(prompt, inputs["model"], acc, depth=depth + 1)


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
_SCHEDULER_MAP = {
    "normal": "Normal",
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
        cfg = _resolve_literal(prompt, inputs.get("cfg"), field="cfg")
        if cfg is None:
            cfg = _resolve_literal(prompt, inputs.get("cfg_scale"), field="cfg_scale")
        cfg_v = _coerce_float(cfg)
        if cfg_v is not None:
            meta["cfg"] = cfg_v
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
        loras: list[tuple[str, float]] = []
        model_in = inputs.get("model")
        _collect_loras(prompt, model_in, loras)
        # _collect_loras walks sampler -> checkpoint, so it appends LoRAs in
        # reverse application order; flip to get base-first ordering.
        loras.reverse()
        if loras:
            meta["loras"] = loras
        # Walk past loras to find the checkpoint name.
        cur = model_in
        for _ in range(16):
            _, node = _follow(prompt, cur)
            if node is None:
                break
            ct = node.get("class_type", "")
            if ct in CHECKPOINT_TYPES:
                name = (
                    node.get("inputs", {}).get("ckpt_name")
                    or node.get("inputs", {}).get("unet_name")
                    or node.get("inputs", {}).get("model_name")
                )
                if name:
                    meta["checkpoint"] = str(name)
                break
            cur = node.get("inputs", {}).get("model")
            if cur is None:
                break

    size = _find_size(prompt, sampler_node)
    if size:
        meta["size"] = size

    return meta


def format_parameters(meta: dict[str, Any]) -> str:
    """Render a metadata dict as an A1111-style ``parameters`` string."""
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
    if "cfg" in meta:
        params.append(f"CFG scale: {meta['cfg']}")
    if "seed" in meta:
        params.append(f"Seed: {meta['seed']}")
    if "size" in meta:
        params.append(f"Size: {meta['size']}")
    if "checkpoint" in meta:
        ckpt = os.path.splitext(os.path.basename(str(meta["checkpoint"])))[0]
        params.append(f"Model: {ckpt}")
    if params:
        parts.append(", ".join(params))
    return "\n".join(parts)
