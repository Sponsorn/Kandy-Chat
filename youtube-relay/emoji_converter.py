"""Emoji converter for YouTube to Twitch chat relay."""

import json
import os
import re
import time


class EmojiConverter:
    """Converts YouTube emoji shortcuts using a configurable mapping file.

    Reads data/emoji-mappings.json (shared with Kandy Chat dashboard).
    Reloads periodically to pick up dashboard changes.
    """

    def __init__(self, data_dir, reload_interval=300):
        self._data_dir = data_dir
        self._file_path = os.path.join(data_dir, "emoji-mappings.json")
        self._mappings = {}
        self._last_reload = 0
        self._reload_interval = reload_interval
        self._pattern = re.compile(r":[a-zA-Z0-9_-]+:")

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
        text_only = self._pattern.sub("", message)
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
        all_emojis = self._pattern.findall(message)
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
            if emoji not in seen:
                if len(unique_order) >= max_unique:
                    return ""
                unique_order.append(emoji)
                seen[emoji] = True
                count = counts[emoji]
                if count > 1:
                    return f"{emoji} x{count} "
                return emoji
            else:
                return ""

        result = self._pattern.sub(replace_match, message)
        # Ensure a space before emojis jammed against text (e.g. "Mom:heart:")
        result = re.sub(r"(?<=\S)(:[a-zA-Z0-9_-]+:)", r" \1", result)
        result = re.sub(r"  +", " ", result).strip()
        return result

    def convert(self, message):
        """Replace mapped emoji shortcuts in the message.

        Unmapped emojis pass through as-is.
        """
        if not self._mappings:
            return message

        def replace_match(match):
            emoji = match.group(0)
            if emoji in self._mappings:
                return self._mappings[emoji]
            return emoji

        return self._pattern.sub(replace_match, message)
