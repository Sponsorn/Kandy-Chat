import json
import time
from unittest.mock import patch, mock_open


def test_convert_replaces_mapped_emojis():
    """Mapped emojis are replaced in the message."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    converter._mappings = {":thumbsup:": "\U0001F44D", ":heart:": "\u2764\uFE0F"}

    result = converter.convert("I :heart: this :thumbsup:")
    assert result == "I \u2764\uFE0F this \U0001F44D"


def test_convert_leaves_unmapped_emojis():
    """Unmapped emojis pass through as-is."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    converter._mappings = {":thumbsup:": "\U0001F44D"}

    result = converter.convert("Check :unknown_emoji: out")
    assert result == "Check :unknown_emoji: out"


def test_convert_strips_emojis_mapped_to_empty():
    """Emojis mapped to empty string are removed."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    converter._mappings = {":yt:": "", ":oops:": ""}

    result = converter.convert("Hello :yt: world :oops:")
    assert result == "Hello  world "


def test_convert_no_emojis():
    """Messages without emojis are returned unchanged."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    converter._mappings = {":thumbsup:": "\U0001F44D"}

    result = converter.convert("No emojis here")
    assert result == "No emojis here"


def test_reload_reads_file():
    """reload() reads the emoji-mappings.json file."""
    from emoji_converter import EmojiConverter

    mappings_data = json.dumps({":test:": "TestVal"})

    with patch("builtins.open", mock_open(read_data=mappings_data)):
        converter = EmojiConverter("/app/data")
        converter.reload()
        assert converter._mappings[":test:"] == "TestVal"


def test_reload_handles_missing_file():
    """reload() uses empty dict when file doesn't exist."""
    from emoji_converter import EmojiConverter

    with patch("builtins.open", side_effect=FileNotFoundError()):
        converter = EmojiConverter("/app/data")
        converter.reload()
        assert converter._mappings == {}


def test_reload_if_needed_respects_interval():
    """reload_if_needed only reloads after interval elapsed."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data", reload_interval=300)
    converter._last_reload = time.time()  # Just loaded
    converter._mappings = {":old:": "old"}

    with patch.object(converter, "reload") as mock_reload:
        converter.reload_if_needed()
        mock_reload.assert_not_called()


# --- collapse_emojis tests ---


def test_collapse_no_emojis():
    """Messages without emojis are returned unchanged."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.collapse_emojis("Hello world") == "Hello world"


def test_collapse_single_emoji():
    """A single emoji is kept as-is."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.collapse_emojis("I :heart: this") == "I :heart: this"


def test_collapse_duplicate_emojis():
    """Duplicate emojis are collapsed with a count."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    result = converter.collapse_emojis("I :heart: :heart: :heart: :smile: text")
    assert result == "I :heart: x3 :smile: text"


def test_collapse_two_duplicates():
    """Two occurrences get x2."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    result = converter.collapse_emojis(":fire: :fire:")
    assert result == ":fire: x2"


def test_collapse_limits_unique_emojis():
    """More than 5 unique emojis — extras are stripped."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    msg = ":a: :b: :c: :d: :e: :f: :g:"
    result = converter.collapse_emojis(msg)
    assert result == ":a: :b: :c: :d: :e:"


def test_collapse_exactly_five_unique():
    """Exactly 5 unique emojis — all kept."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    msg = ":a: :b: :c: :d: :e:"
    result = converter.collapse_emojis(msg)
    assert result == ":a: :b: :c: :d: :e:"


def test_collapse_duplicates_and_unique_limit():
    """Duplicates are collapsed AND unique limit is enforced."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    msg = ":a: :a: :a: :b: :c: :d: :e: :f: :f:"
    result = converter.collapse_emojis(msg)
    assert result == ":a: x3 :b: :c: :d: :e:"


def test_collapse_adjacent_emojis():
    """Adjacent emojis without spaces are handled."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    result = converter.collapse_emojis(":heart::heart::heart:")
    assert result == ":heart: x3"


def test_collapse_mixed_text_and_emojis():
    """Text between emojis is preserved."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    result = converter.collapse_emojis("hello :wave: nice :wave: bye")
    assert result == "hello :wave: x2 nice bye"


def test_collapse_custom_max_unique():
    """max_unique parameter is respected."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    msg = ":a: :b: :c: :d:"
    result = converter.collapse_emojis(msg, max_unique=2)
    assert result == ":a: :b:"


def test_collapse_only_emojis_all_same():
    """Message of only repeated emojis collapses to one with count."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    result = converter.collapse_emojis(":thanksdoc: :thanksdoc: :thanksdoc:")
    assert result == ":thanksdoc: x3"


def test_normalize_caps_all_uppercase():
    """ALL CAPS message is lowercased."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.normalize_caps("LOVE MOM") == "love mom"


def test_normalize_caps_mixed_case_unchanged():
    """Mixed case message is left alone."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.normalize_caps("Hello World") == "Hello World"


def test_normalize_caps_ignores_emoji_shortcodes():
    """Emoji shortcodes don't count toward the caps check."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    msg = "LOVE MOM:yougotthis::thanksdoc:"
    assert converter.normalize_caps(msg) == "love mom:yougotthis::thanksdoc:"


def test_normalize_caps_single_char_unchanged():
    """Single alpha character is not enough to trigger lowercasing."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.normalize_caps("A") == "A"


def test_normalize_caps_no_alpha_unchanged():
    """Message with no alpha characters is left alone."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.normalize_caps("123 :heart: :heart:") == "123 :heart: :heart:"


def test_collapse_space_between_text_and_emoji():
    """A space is inserted when an emoji is jammed against text."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    msg = "Love Mom:yougotthis::yougotthis::thanksdoc::thanksdoc:"
    result = converter.collapse_emojis(msg)
    assert result == "Love Mom :yougotthis: x2 :thanksdoc: x2"
