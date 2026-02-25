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
