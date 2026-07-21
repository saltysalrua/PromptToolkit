"""Shared tag-matching helpers for PromptToolkit nodes."""

import re
from collections.abc import Iterable


def parse_rules(raw: str) -> list[tuple[str, str]]:
    """Parse a multi-line ``find -> replace`` block.

    Empty lines and ``#`` comments are skipped. Lines without ``->``
    or with an empty find side are silently dropped so a typo never
    breaks the whole prompt.
    """
    rules: list[tuple[str, str]] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "->" not in stripped:
            continue
        find, _, replace = stripped.partition("->")
        find = find.strip()
        if not find:
            continue
        rules.append((find, replace.strip()))
    return rules


def parse_tag_list(raw: str) -> list[str]:
    """Parse a block of tags separated by newlines and/or commas."""
    tags: list[str] = []
    for chunk in raw.replace("\n", ",").split(","):
        tag = chunk.strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def build_pattern(
    needle: str,
    *,
    use_regex: bool,
    whole_word: bool,
    case_sensitive: bool,
) -> re.Pattern:
    """Compile a search pattern for one tag/rule."""
    body = needle if use_regex else re.escape(needle)
    if whole_word:
        # Comma / parenthesis / whitespace friendly boundaries so
        # `cat` does not match inside `category`, while `(cat:1.2)`
        # and multi-word tags like `cat ears` still match as a unit.
        body = r"(?<![A-Za-z0-9_])" + body + r"(?![A-Za-z0-9_])"
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(body, flags)


def apply_replacements(
    text: str,
    rules: Iterable[tuple[str, str]],
    *,
    use_regex: bool,
    whole_word: bool,
    case_sensitive: bool = False,
) -> str:
    """Apply ``find -> replace`` rules to ``text`` in order."""
    result = text
    for find, replace in rules:
        if not find:
            continue
        try:
            pattern = build_pattern(
                find,
                use_regex=use_regex,
                whole_word=whole_word,
                case_sensitive=case_sensitive,
            )
        except re.error:
            continue
        result = pattern.sub(replace if replace is not None else "", result)
    return result


def strip_tags(
    text: str,
    tags: Iterable[str],
    *,
    use_regex: bool,
    whole_word: bool,
    case_sensitive: bool = False,
) -> str:
    """Remove every tag in ``tags`` from ``text`` and tidy the result.

    Weighted-tag wrappers like ``(tag:1.2)`` are handled: removing the
    inner tag drops the whole ``(...)`` group. Leftover commas and
    whitespace are collapsed so the output stays clean.
    """
    if not text:
        return text

    # First, drop whole weighted groups whose inner text equals a tag,
    # e.g. ``(loli:1.2)`` -> ````. We only do this for plain (non-regex)
    # tags because regex inside parentheses is ambiguous.
    result = text
    if not use_regex:
        for tag in tags:
            if not tag:
                continue
            esc = re.escape(tag)
            # (tag:weight) or (tag)
            group_pat = re.compile(
                r"\(\s*" + esc + r"\s*(?::[^()]*)?\)",
                re.IGNORECASE if not case_sensitive else 0,
            )
            result = group_pat.sub("", result)

    # Then strip bare occurrences of each tag.
    rules = [(tag, "") for tag in tags]
    result = apply_replacements(
        result,
        rules,
        use_regex=use_regex,
        whole_word=whole_word,
        case_sensitive=case_sensitive,
    )

    # Tidy: drop empty weighted groups and groups left with only a
    # weight, collapse repeated commas, normalise spacing, then trim.
    result = re.sub(r"\(\s*,+\s*\)", "", result)  # empty weighted groups
    result = re.sub(r"\(\s*,+\s*", "(", result)  # (, cute:1.2) -> (cute:1.2)
    result = re.sub(r",\s*:", ":", result)  # (cute, :1.2) -> (cute:1.2)
    result = re.sub(r"\(\s*:[^()]*\)", "", result)  # group left with only a weight
    result = re.sub(r"\(\s+", "(", result)
    result = re.sub(r"\s+\)", ")", result)
    result = re.sub(r"(,\s*)+", ", ", result)  # collapse repeated commas
    result = re.sub(r"\s{2,}", " ", result)
    return result.strip(" ,")


def scrub_tags(
    text: str,
    tags: Iterable[str],
    *,
    use_regex: bool,
    whole_word: bool,
    case_sensitive: bool = False,
) -> str:
    """Strip tags from an arbitrary string with minimal collateral edits.

    Unlike :func:`strip_tags` this is meant for non-prompt strings (e.g.
    values inside the workflow JSON) so it skips the aggressive spacing /
    comma tidying that could mangle unrelated content. Strings that do
    not contain any tag are returned unchanged.
    """
    if not text or not isinstance(text, str):
        return text
    tag_list = [t for t in tags if t]
    if not tag_list:
        return text
    # Cheap relevance check: only touch strings that actually contain a
    # tag substring. Skipped for regex mode where the check is unreliable.
    if not use_regex:
        hay = text if case_sensitive else text.lower()
        if not any((t if case_sensitive else t.lower()) in hay for t in tag_list):
            return text

    result = text
    if not use_regex:
        for tag in tag_list:
            esc = re.escape(tag)
            group_pat = re.compile(
                r"\(\s*" + esc + r"\s*(?::[^()]*)?\)",
                re.IGNORECASE if not case_sensitive else 0,
            )
            result = group_pat.sub("", result)
    rules = [(tag, "") for tag in tag_list]
    result = apply_replacements(
        result,
        rules,
        use_regex=use_regex,
        whole_word=whole_word,
        case_sensitive=case_sensitive,
    )
    # Minimal, safe tidy only.
    result = re.sub(r"\(\s*,+\s*\)", "", result)
    result = re.sub(r"\(\s*,+\s*", "(", result)
    result = re.sub(r",\s*:", ":", result)
    result = re.sub(r"(,\s*)+", ", ", result)
    return result.strip(" ,")


def scrub_object(obj, tags, *, use_regex, whole_word, case_sensitive=False):
    """Recursively scrub tags from every string inside a nested structure."""
    if isinstance(obj, str):
        return scrub_tags(
            obj,
            tags,
            use_regex=use_regex,
            whole_word=whole_word,
            case_sensitive=case_sensitive,
        )
    if isinstance(obj, dict):
        return {
            key: scrub_object(
                value,
                tags,
                use_regex=use_regex,
                whole_word=whole_word,
                case_sensitive=case_sensitive,
            )
            for key, value in obj.items()
        }
    if isinstance(obj, list):
        return [
            scrub_object(
                item,
                tags,
                use_regex=use_regex,
                whole_word=whole_word,
                case_sensitive=case_sensitive,
            )
            for item in obj
        ]
    return obj
