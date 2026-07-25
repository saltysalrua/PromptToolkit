"""A pass-through prompt node with a floating-panel companion widget.

The node itself is a simple STRING passthrough: positive and negative
prompts go in, positive and negative prompts come out.  The real value
is the frontend extension (``web/prompt_panel.js``) which attaches a
draggable floating panel to the node so the user can edit both prompts
without scrolling around the graph.
"""

from __future__ import annotations

from typing import Any

from .ai_bridge import register_prompt


class PromptPanel:
    """A prompt holder node with a floating-panel editor on the frontend."""

    NAME = "Prompt Panel"
    CATEGORY = "PromptToolkit"
    DESCRIPTION = (
        "A positive/negative prompt holder with a draggable floating "
        "panel for quick editing without navigating the graph."
    )

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "positive": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Positive prompt text.",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("positive",)
    FUNCTION = "passthrough"
    OUTPUT_NODE = True

    def passthrough(self, positive: str = "", unique_id: Any = None) -> tuple[str]:
        # Publish the text to the AI bridge so a harness can read it back.
        register_prompt(unique_id, positive)
        return (positive,)
