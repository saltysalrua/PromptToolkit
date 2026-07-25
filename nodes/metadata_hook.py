"""Runtime metadata capture for PromptToolkit.

ComfyUI passes every output node the full prompt graph as the hidden
``prompt`` input, which is enough to recover most generation parameters
statically (see metadata_extractor.py). It is NOT enough to recover the
positive/negative prompt text when the text flows through an opaque node
whose internal logic is not visible in the graph - e.g. a dual-encoder
group/template node that combines ``positive_1`` + ``positive_2`` into a
CONDITIONING output. The static graph only sees the node's input *refs*,
and following them can dead-end in nodes whose text is produced at run
time (LoraManager's TriggerWord Toggle) or buried in a subgraph.

The robust fix (the one comfyui-lora-manager's Save Image node uses) is to
hook ComfyUI's execution and record each node's *resolved* inputs - by the
time a node's FUNCTION runs, ComfyUI has already followed every ref, so
``input_data_all`` contains the actual string/tensor values. We keep a
tiny per-prompt-id registry of those inputs keyed by node id; the prompt
extractor then reads the resolved text straight off the encoder node that
feeds the sampler's ``positive``/``negative`` input.

This module is self-contained (no cross-plugin imports) and degrades
gracefully: if the execution module can't be located or the hook fails to
install, the static extractor is used as before.
"""

from __future__ import annotations

import inspect
import logging
import sys

logger = logging.getLogger(__name__)


class RuntimeCapture:
    """Singleton registry of resolved node inputs for the current prompt."""

    _instance: RuntimeCapture | None = None

    def __new__(cls) -> RuntimeCapture:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance.reset()
        return cls._instance

    def reset(self) -> None:
        self.prompt_id: str | None = None
        self.nodes: dict[str, dict] = {}

    def start(self, prompt_id: str) -> None:
        self.prompt_id = prompt_id
        self.nodes = {}

    def record(self, node_id, class_type: str, inputs) -> None:
        """Record a node's resolved inputs (called pre-execution)."""
        if node_id is None:
            return
        resolved: dict = {}
        if inputs:
            for name, values in inputs.items():
                # ComfyUI passes list-wrapped values (batch); take the first
                # element for the common single-value case.
                if isinstance(values, list) and values:
                    resolved[name] = values[0]
                else:
                    resolved[name] = values
        self.nodes[str(node_id)] = {"class_type": class_type, "inputs": resolved}

    def get(self, node_id) -> dict | None:
        return self.nodes.get(str(node_id))


CAPTURE = RuntimeCapture()


def _get_execution_module():
    try:
        import execution  # type: ignore

        return execution
    except ImportError:
        for name in sys.modules:
            if name.endswith(".execution"):
                return sys.modules[name]
    return None


def _node_id_from_frame(obj):
    """Best-effort node_id for the sync execution path (no unique_id param)."""
    nid = getattr(obj, "unique_id", None)
    if nid is not None:
        return nid
    frame = inspect.currentframe()
    while frame:
        if "unique_id" in frame.f_locals:
            return frame.f_locals["unique_id"]
        frame = frame.f_back
    return None


def install() -> bool:
    """Install the execution hooks. Returns True on success."""
    execution = _get_execution_module()
    if execution is None:
        logger.warning(
            "[PromptToolkit] ComfyUI execution module not found; "
            "runtime prompt capture disabled (static extraction only)."
        )
        return False

    is_async = False
    map_name = "_map_node_over_list"
    if hasattr(execution, "_async_map_node_over_list"):
        is_async = inspect.iscoroutinefunction(execution._async_map_node_over_list)
        map_name = "_async_map_node_over_list"
    elif not hasattr(execution, "_map_node_over_list"):
        logger.warning(
            "[PromptToolkit] execution._map_node_over_list not found; "
            "runtime prompt capture disabled."
        )
        return False

    try:
        if is_async:
            _install_async(execution, map_name)
        else:
            _install_sync(execution)
        logger.info("[PromptToolkit] runtime prompt capture hook installed.")
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "[PromptToolkit] failed to install runtime prompt capture hook: %s", exc
        )
        return False


def _install_sync(execution) -> None:
    original_map = execution._map_node_over_list

    def map_with_capture(
        obj,
        input_data_all,
        func,
        allow_interrupt=False,
        execution_block_cb=None,
        pre_execute_cb=None,
    ):
        if func == getattr(obj, "FUNCTION", None) and hasattr(obj, "__class__"):
            try:
                nid = _node_id_from_frame(obj)
                if nid is not None:
                    CAPTURE.record(nid, obj.__class__.__name__, input_data_all)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("[PromptToolkit] capture error: %s", exc)
        return original_map(
            obj,
            input_data_all,
            func,
            allow_interrupt,
            execution_block_cb,
            pre_execute_cb,
        )

    execution._map_node_over_list = map_with_capture
    _hook_execute(execution, sync=True)


def _install_async(execution, map_name: str) -> None:
    original_map = getattr(execution, map_name)

    async def map_with_capture(
        prompt_id,
        unique_id,
        obj,
        input_data_all,
        func,
        allow_interrupt=False,
        execution_block_cb=None,
        pre_execute_cb=None,
        v3_data=None,
    ):
        if func == getattr(obj, "FUNCTION", None) and hasattr(obj, "__class__"):
            try:
                if unique_id is not None:
                    CAPTURE.record(unique_id, obj.__class__.__name__, input_data_all)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("[PromptToolkit] capture error: %s", exc)
        return await original_map(
            prompt_id,
            unique_id,
            obj,
            input_data_all,
            func,
            allow_interrupt,
            execution_block_cb,
            pre_execute_cb,
            v3_data=v3_data,
        )

    setattr(execution, map_name, map_with_capture)
    _hook_execute(execution, sync=False)


def _hook_execute(execution, *, sync: bool) -> None:
    original_execute = execution.execute

    if sync:

        def execute_with_prompt_tracking(*args, **kwargs):
            if len(args) >= 7:
                prompt_id = args[6]
                if CAPTURE.prompt_id != prompt_id:
                    CAPTURE.start(prompt_id)
            return original_execute(*args, **kwargs)

        execution.execute = execute_with_prompt_tracking
    else:

        async def aexecute_with_prompt_tracking(*args, **kwargs):
            if len(args) >= 7:
                prompt_id = args[6]
                if CAPTURE.prompt_id != prompt_id:
                    CAPTURE.start(prompt_id)
            return await original_execute(*args, **kwargs)

        execution.execute = aexecute_with_prompt_tracking
