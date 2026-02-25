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
        self._pattern = re.compile(r":[a-zA-Z0-9_]+:")

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
