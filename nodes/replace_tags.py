"""Find-and-replace tags inside a prompt string."""

from __future__ import annotations

import re
from typing import Any

from .tag_utils import apply_replacements, parse_rules


class ReplaceTagsNode:
    """Find and replace tags inside a prompt string.

    Input ``replacements`` is a multi-line block where each line is
    ``find -> replace``. Lines starting with ``#`` are comments.
    """

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, Any]]:
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                    },
                ),
                "replacements": (
                    "STRING",
                    {
                        "default": "# 1011 -> loli\n# 1girl -> 2girls",
                        "multiline": True,
                    },
                ),
                "use_regex": ("BOOLEAN", {"default": False}),
                "whole_word": ("BOOLEAN", {"default": True}),
                "case_sensitive": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "prompt_opt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "replace_tags"
    CATEGORY = "PromptToolkit"

    def replace_tags(
        self,
        prompt: str = "",
        replacements: str = "",
        use_regex: bool = False,
        whole_word: bool = True,
        case_sensitive: bool = False,
        prompt_opt: str = "",
    ) -> tuple[str]:
        # The optional input wins when provided/non-empty, so this node
        # can sit after another text node without clobbering its output
        # when nothing is wired into the required slot.
        text = prompt_opt if prompt_opt else prompt
        rules = parse_rules(replacements)
        result = apply_replacements(
            text,
            rules,
            use_regex=use_regex,
            whole_word=whole_word,
            case_sensitive=case_sensitive,
        )
        # Light tidy so deleting a tag (find -> empty) does not leave
        # dangling/doubled commas. Kept minimal to avoid mangling non-tag
        # text: only collapses repeated commas and trims the ends.
        result = re.sub(r"(,\s*)+", ", ", result)
        result = re.sub(r"\s{2,}", " ", result)
        return (result.strip(" ,"),)
