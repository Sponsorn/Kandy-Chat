"""Script-based message filters for the YouTube -> Twitch relay."""

import re

# Cyrillic, Cyrillic Supplement, Extended-A/B/C
_CYRILLIC = "Ѐ-ԯᲀ-᲏ⷠ-ⷿꙀ-ꚟ"
_CYRILLIC_RE = re.compile(f"[{_CYRILLIC}]")
_SHORTCODE_RE = re.compile(r":[\w-]+:")


def filter_cyrillic(message):
    """Drop mostly-Cyrillic messages and strip stray Cyrillic letters from the rest.

    Emoji shortcodes (``:heart:``) are ignored when counting letters.

    Returns ``(text, reason)``: ``text`` is the message to relay, or ``None`` when it should
    be skipped, in which case ``reason`` says why. Messages without Cyrillic are returned
    unchanged.
    """
    if not message or not _CYRILLIC_RE.search(message):
        return message, None

    letters = [c for c in _SHORTCODE_RE.sub("", message) if c.isalpha()]
    cyrillic = sum(1 for c in letters if _CYRILLIC_RE.match(c))
    if cyrillic * 2 > len(letters):
        return None, "mostly Cyrillic"

    stripped = re.sub(r"\s{2,}", " ", _CYRILLIC_RE.sub("", message)).strip()
    if not any(c.isalnum() for c in _SHORTCODE_RE.sub("", stripped)):
        return None, "nothing left after removing Cyrillic"
    return stripped, None
