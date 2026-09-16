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


# --- unmapped emoji tracking ---


def test_convert_records_unmapped_emojis(tmp_path):
    """Shortcodes without a mapping are recorded with a count and sample."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter(str(tmp_path))
    converter._mappings = {":heart:": "❤️"}

    converter.convert("hi :heart: :mystery: :mystery:")
    converter.convert(":mystery: again and :other:")

    unmapped = converter.unmapped
    assert set(unmapped) == {":mystery:", ":other:"}
    # Counted once per message, not per occurrence
    assert unmapped[":mystery:"]["count"] == 2
    assert unmapped[":other:"]["count"] == 1
    assert unmapped[":mystery:"]["sample"] == "hi :heart: :mystery: :mystery:"
    assert ":heart:" not in unmapped


def test_unmapped_is_written_to_disk_and_reloaded(tmp_path):
    from emoji_converter import EmojiConverter

    converter = EmojiConverter(str(tmp_path))
    converter._mappings = {}
    converter.convert("look :new_one:")
    converter.flush_unmapped(force=True)

    path = tmp_path / "emoji-unmapped.json"
    assert path.exists()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data[":new_one:"]["count"] == 1

    # A fresh converter picks the counts back up
    again = EmojiConverter(str(tmp_path))
    again._mappings = {}
    again.convert("look :new_one:")
    assert again.unmapped[":new_one:"]["count"] == 2


def test_reload_drops_unmapped_that_got_mapped(tmp_path):
    """Once the dashboard maps a shortcode it disappears from the unmapped list."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter(str(tmp_path))
    converter._mappings = {}
    converter.convert("see :soon_mapped: and :still_unmapped:")

    (tmp_path / "emoji-mappings.json").write_text(
        json.dumps({":soon_mapped:": "OK"}), encoding="utf-8"
    )
    converter.reload()

    assert ":soon_mapped:" not in converter.unmapped
    assert ":still_unmapped:" in converter.unmapped
    on_disk = json.loads((tmp_path / "emoji-unmapped.json").read_text(encoding="utf-8"))
    assert ":soon_mapped:" not in on_disk


def test_unmapped_list_is_bounded(tmp_path):
    from emoji_converter import EmojiConverter
    import emoji_converter

    converter = EmojiConverter(str(tmp_path))
    converter._mappings = {}
    for i in range(emoji_converter._UNMAPPED_MAX + 25):
        converter.record_unmapped(f":e{i}:")
    assert len(converter.unmapped) == emoji_converter._UNMAPPED_MAX


# --- unicode emoji collapsing ---


def test_collapse_unicode_flag_spam():
    """Repeated Unicode emojis (flags) collapse like shortcodes do."""
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    flag = "\U0001F1E7\U0001F1F7"
    result = converter.collapse_emojis(flag * 22)
    assert result == f"{flag} x22"


def test_collapse_mixed_unicode_and_shortcodes():
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    result = converter.collapse_emojis("go \U0001F525\U0001F525 :heart: \U0001F525 :heart:")
    assert result == "go \U0001F525 x3 :heart: x2"


def test_collapse_keeps_zwj_and_skin_tone_sequences_intact():
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    family = "\U0001F468‍\U0001F469‍\U0001F467"
    wave = "\U0001F44B\U0001F3FD"
    result = converter.collapse_emojis(f"{family}{family} {wave}{wave}{wave}")
    assert result == f"{family} x2 {wave} x3"


def test_collapse_limits_unique_unicode_emojis():
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    emojis = ["\U0001F600", "\U0001F601", "\U0001F602", "\U0001F603", "\U0001F604", "\U0001F605"]
    result = converter.collapse_emojis(" ".join(emojis), max_unique=5)
    assert result == " ".join(emojis[:5])


def test_normalize_caps_ignores_unicode_emojis():
    from emoji_converter import EmojiConverter

    converter = EmojiConverter("/app/data")
    assert converter.normalize_caps("LETS GO \U0001F525") == "lets go \U0001F525"
    assert converter.normalize_caps("\U0001F1E7\U0001F1F7 Hi") == "\U0001F1E7\U0001F1F7 Hi"


def test_convert_does_not_treat_unicode_emojis_as_unmapped(tmp_path):
    from emoji_converter import EmojiConverter

    converter = EmojiConverter(str(tmp_path))
    converter._mappings = {}
    converter.convert("nice \U0001F1E7\U0001F1F7 :real_unmapped:")
    assert set(converter.unmapped) == {":real_unmapped:"}
