"""Emoji converter for YouTube to Twitch chat relay."""

import json
import os
import re
import time
from datetime import datetime, timezone

_UNICODE_EMOJI = (
    r"(?:[\U0001F1E6-\U0001F1FF]{2}"  # flags
    r"|(?:[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u3030\u303D\u3297\u3299]"
    r"|[0-9#*]\uFE0F?\u20E3)"  # keycaps
    r"[\uFE0F\U0001F3FB-\U0001F3FF]*"
    r"(?:\u200D[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF][\uFE0F\U0001F3FB-\U0001F3FF]*)*)"
)
_EMOJI_TOKEN_RE = r":[a-zA-Z0-9_-]+:|" + _UNICODE_EMOJI

# Keep at most this many distinct unmapped emojis on disk
_UNMAPPED_MAX = 500
# Do not rewrite the unmapped file more often than this
_UNMAPPED_FLUSH_INTERVAL = 10


class EmojiConverter:
    """Converts YouTube emoji shortcuts using a configurable mapping file.

    Reads data/emoji-mappings.json (shared with Kandy Chat dashboard).
    Reloads periodically to pick up dashboard changes.
    """

    def __init__(self, data_dir, reload_interval=300):
        self._data_dir = data_dir
        self._file_path = os.path.join(data_dir, "emoji-mappings.json")
        self._unmapped_path = os.path.join(data_dir, "emoji-unmapped.json")
        self._mappings = {}
        self._last_reload = 0
        self._reload_interval = reload_interval
        # Shortcodes that can be mapped via emoji-mappings.json
        self._pattern = re.compile(r":[a-zA-Z0-9_-]+:")
        # Anything that counts as one emoji for collapsing: a shortcode, or a
        # Unicode emoji (flags as regional-indicator pairs, base symbol with
        # optional variation selector / skin tone, ZWJ sequences)
        self._token_pattern = re.compile(_EMOJI_TOKEN_RE)
        # Shortcodes seen in chat that have no mapping: { ":code:": {"count", "last_seen", "sample"} }
        # Shared with the dashboard via data/emoji-unmapped.json so they can be mapped there.
        self._unmapped = {}
        self._unmapped_dirty = False
        self._unmapped_last_flush = 0
        self._load_unmapped()

    def reload(self):
        """Reload mappings from the JSON file."""
        try:
            with open(self._file_path, "r", encoding="utf-8") as f:
                self._mappings = json.load(f)
            self._last_reload = time.time()
        except FileNotFoundError:
            self._mappings = {}
            self._last_reload = time.time()
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: Failed to load emoji mappings: {e}")
            return

        # Anything mapped since the last reload no longer counts as unmapped
        stale = [code for code in self._unmapped if code in self._mappings]
        if stale:
            for code in stale:
                del self._unmapped[code]
            self._unmapped_dirty = True
            self.flush_unmapped(force=True)

    # ------------------------------------------------------------ unmapped tracking

    def _load_unmapped(self):
        """Load previously recorded unmapped emojis so counts survive a restart."""
        try:
            with open(self._unmapped_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._unmapped = {
                    code: entry for code, entry in data.items()
                    if isinstance(entry, dict) and isinstance(entry.get("count"), int)
                }
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            self._unmapped = {}

    def record_unmapped(self, emoji, sample=None):
        """Note that an unmapped shortcode was seen in chat."""
        entry = self._unmapped.get(emoji)
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if entry is None:
            entry = {"count": 0, "last_seen": now, "sample": ""}
            self._unmapped[emoji] = entry
        entry["count"] += 1
        entry["last_seen"] = now
        if sample and not entry.get("sample"):
            entry["sample"] = sample[:200]
        self._unmapped_dirty = True

        # Bound the file: drop the least recently seen entries
        if len(self._unmapped) > _UNMAPPED_MAX:
            by_age = sorted(self._unmapped.items(), key=lambda kv: kv[1].get("last_seen", ""))
            for code, _ in by_age[: len(self._unmapped) - _UNMAPPED_MAX]:
                del self._unmapped[code]

    def flush_unmapped(self, force=False):
        """Write the unmapped list to disk (atomically), throttled unless forced."""
        if not self._unmapped_dirty:
            return
        now = time.time()
        if not force and now - self._unmapped_last_flush < _UNMAPPED_FLUSH_INTERVAL:
            return
        if not os.path.isdir(self._data_dir):
            return
        tmp_path = self._unmapped_path + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self._unmapped, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, self._unmapped_path)
            self._unmapped_dirty = False
            self._unmapped_last_flush = now
        except OSError as e:
            print(f"Warning: Failed to write unmapped emojis: {e}")

    @property
    def unmapped(self):
        """Read-only view of the unmapped emojis recorded so far."""
        return dict(self._unmapped)

    def reload_if_needed(self):
        """Reload mappings if the interval has elapsed."""
        if time.time() - self._last_reload >= self._reload_interval:
            self.reload()

    def normalize_caps(self, message):
        """Convert ALL CAPS messages to lowercase.

        Checks only alphabetic characters outside emoji shortcodes.
        If all are uppercase (and there are at least 2), the message
        is lowercased. Emoji shortcodes are unaffected since they
        are already lowercase.
        """
        text_only = self._token_pattern.sub("", message)
        alpha_chars = [c for c in text_only if c.isalpha()]
        if len(alpha_chars) >= 2 and all(c.isupper() for c in alpha_chars):
            return message.lower()
        return message

    def collapse_emojis(self, message, max_unique=5):
        """Collapse duplicate emojis and limit unique emoji count.

        - Consecutive or scattered duplicates are collapsed:
          `:heart: :heart: :heart:` → `:heart: x3`
        - At most `max_unique` unique emojis are kept; extras are stripped.
        - Extra whitespace left by removals is cleaned up.
        """
        all_emojis = self._token_pattern.findall(message)
        if not all_emojis:
            return message

        # Count occurrences of each emoji
        counts = {}
        for emoji in all_emojis:
            counts[emoji] = counts.get(emoji, 0) + 1

        seen = {}
        unique_order = []

        def replace_match(match):
            emoji = match.group(0)
            if emoji in seen:
                return ""
            if len(unique_order) >= max_unique:
                return ""
            unique_order.append(emoji)
            seen[emoji] = True
            # Ensure a space before emojis jammed against text (e.g. "Mom:heart:").
            # Decided here, on the original string, so a flag or ZWJ sequence is
            # never split by a second pass.
            start = match.start()
            prefix = " " if start > 0 and not message[start - 1].isspace() else ""
            count = counts[emoji]
            if count > 1:
                return f"{prefix}{emoji} x{count} "
            return f"{prefix}{emoji}"

        result = self._token_pattern.sub(replace_match, message)
        result = re.sub(r"  +", " ", result).strip()
        return result

    def convert(self, message):
        """Replace mapped emoji shortcuts in the message.

        Unmapped emojis pass through as-is and are recorded so the dashboard
        can list them for mapping.
        """
        seen_unmapped = set()

        def replace_match(match):
            emoji = match.group(0)
            if emoji in self._mappings:
                return self._mappings[emoji]
            if emoji not in seen_unmapped:
                seen_unmapped.add(emoji)
                self.record_unmapped(emoji, sample=message)
            return emoji

        result = self._pattern.sub(replace_match, message)
        if seen_unmapped:
            self.flush_unmapped()
        return result
