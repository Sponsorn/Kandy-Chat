"""Twitch API client for the YouTube relay (send-only, no chat reading)."""

import json
import os
import re
import time
import requests
from datetime import datetime, timezone
from typing import Optional, List


def _log(msg):
    """Print with timestamp and immediate flush."""
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    print(f"[{ts}] {msg}", flush=True)


def _data_path(filename):
    """Resolve a file path in the data directory (works locally and in Docker)."""
    # ../data for local dev (youtube-relay/../data/), ./data for Docker (/app/data/)
    path = os.path.join(os.path.dirname(__file__), "..", "data", filename)
    if os.path.exists(path):
        return path
    return os.path.join(os.path.dirname(__file__), "data", filename)


class TwitchBot:
    """Sends messages to Twitch chat via Helix API.

    Unlike a full chat bot, this only sends messages — it does not
    read Twitch chat or use WebSocket EventSub.

    Token management: reads access token from shared data/tokens.json
    (written by the main kandy-chat bot). Falls back to own refresh
    only when tokens.json is unavailable.
    """

    def __init__(self, bot_user_id, oauth_token, client_id, channel_user_id,
                 broadcaster_oauth_token=None, client_secret=None,
                 bot_refresh_token=None, broadcaster_refresh_token=None):
        self.bot_user_id = bot_user_id
        self.oauth_token = oauth_token
        self.broadcaster_oauth_token = broadcaster_oauth_token or oauth_token
        self.client_id = client_id
        self.client_secret = client_secret
        self.bot_refresh_token = bot_refresh_token
        self.broadcaster_refresh_token = broadcaster_refresh_token
        self.channel_user_id = channel_user_id
        self.blocked_terms = []
        self._blocked_regexes = []
        self._last_blacklist_check = 0
        self._blacklist_check_interval = 0
        self._blacklist_mtime = 0

    # ── Shared token file ──────────────────────────────────────────

    def _load_shared_tokens(self):
        """Load tokens from shared data/tokens.json (written by main bot)."""
        tokens_path = _data_path("tokens.json")
        try:
            with open(tokens_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            access = data.get("accessToken")
            refresh = data.get("refreshToken")
            if access:
                return access, refresh
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        return None, None

    def _persist_shared_tokens(self, access_token, refresh_token):
        """Write tokens to shared data/tokens.json for other services."""
        tokens_path = _data_path("tokens.json")
        try:
            data = {
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            }
            with open(tokens_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except OSError as e:
            _log(f"Could not persist tokens: {e}")

    # ── Token management ──────────────────────────────────────────

    def refresh_access_token(self, refresh_token):
        """Refresh an OAuth token. Returns (access_token, refresh_token) or None."""
        if not self.client_secret or not refresh_token:
            return None

        try:
            response = requests.post(
                "https://id.twitch.tv/oauth2/token",
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                },
                timeout=5,
            )

            if response.status_code != 200:
                _log(f"Token refresh failed: {response.status_code}")
                return None

            data = response.json()
            new_access = data["access_token"]
            new_refresh = data["refresh_token"]
            _log("Successfully refreshed OAuth token")
            self._persist_shared_tokens(new_access, new_refresh)
            return (new_access, new_refresh)

        except requests.exceptions.RequestException as e:
            _log(f"Token refresh error: {e}")
            return None

    def _reload_token_from_shared(self):
        """Try to reload a fresh token from tokens.json. Returns True if updated."""
        access, refresh = self._load_shared_tokens()
        if access and access != self.oauth_token:
            _log("Loaded updated token from shared tokens.json")
            self.oauth_token = access
            if refresh:
                self.bot_refresh_token = refresh
            return True
        return False

    def validate_token(self):
        """Validate bot token, refresh if expired. Returns True if valid."""
        try:
            response = requests.get(
                "https://id.twitch.tv/oauth2/validate",
                headers={"Authorization": f"OAuth {self.oauth_token}"},
                timeout=5,
            )

            if response.status_code == 401:
                # Try shared tokens.json first (main bot may have refreshed)
                if self._reload_token_from_shared():
                    return self.validate_token()
                # Fall back to own refresh
                if self.bot_refresh_token:
                    _log("Bot token expired, attempting refresh...")
                    result = self.refresh_access_token(self.bot_refresh_token)
                    if result:
                        self.oauth_token, self.bot_refresh_token = result
                        return True
                _log("Failed to refresh bot token")
                return False

            if response.status_code != 200:
                _log(f"Token validation failed: {response.status_code}")
                return False

            return True

        except requests.exceptions.RequestException as e:
            _log(f"Token validation error: {e}")
            return False

    # ── Connect / disconnect ──────────────────────────────────────

    def connect(self):
        """Load shared tokens, validate, and fetch blocked terms."""
        # Try to use token from shared tokens.json (written by main bot)
        access, refresh = self._load_shared_tokens()
        if access:
            _log("Using access token from shared tokens.json")
            self.oauth_token = access
            if refresh:
                self.bot_refresh_token = refresh

        if not self.validate_token():
            raise Exception("Bot OAuth token validation failed")

        # Sync broadcaster token to bot token
        self.broadcaster_oauth_token = self.oauth_token

        # Fetch blocked terms
        self.fetch_blocked_terms()
        self._last_blacklist_check = time.time()

        _log("Twitch API client ready")

    def disconnect(self):
        """No-op (no persistent connection to close)."""
        pass

    # ── Messaging ─────────────────────────────────────────────────

    def send_message(self, message):
        """Send a message to the Twitch channel via Helix API."""
        try:
            response = requests.post(
                "https://api.twitch.tv/helix/chat/messages",
                headers={
                    "Authorization": f"Bearer {self.oauth_token}",
                    "Client-Id": self.client_id,
                    "Content-Type": "application/json",
                },
                json={
                    "broadcaster_id": self.channel_user_id,
                    "sender_id": self.bot_user_id,
                    "message": message,
                },
                timeout=5,
            )

            if response.status_code != 200:
                _log(f"Failed to send message: {response.status_code}")
                error = response.json()
                _log(f"  {error}")

                if response.status_code == 401:
                    # Try reloading from shared tokens.json first
                    if self._reload_token_from_shared():
                        _log("Retrying with shared token...")
                    elif self.bot_refresh_token:
                        _log("Refreshing token and retrying...")
                        result = self.refresh_access_token(self.bot_refresh_token)
                        if not result:
                            return
                        self.oauth_token, self.bot_refresh_token = result
                    else:
                        return

                    # Retry once with updated token
                    retry = requests.post(
                        "https://api.twitch.tv/helix/chat/messages",
                        headers={
                            "Authorization": f"Bearer {self.oauth_token}",
                            "Client-Id": self.client_id,
                            "Content-Type": "application/json",
                        },
                        json={
                            "broadcaster_id": self.channel_user_id,
                            "sender_id": self.bot_user_id,
                            "message": message,
                        },
                        timeout=5,
                    )
                    if retry.status_code == 200:
                        return
                    _log(f"Retry failed: {retry.status_code}")

        except requests.exceptions.RequestException as e:
            _log(f"Error sending message: {e}")

    # ── Blocked terms ─────────────────────────────────────────────

    def fetch_blocked_terms(self):
        """Load blocked terms from local data/blacklist.json file.

        Entries starting with '/' are parsed as regex (/pattern/flags),
        everything else is plain text (case-insensitive substring match).
        """
        blacklist_path = _data_path("blacklist.json")

        try:
            self._blacklist_mtime = os.path.getmtime(blacklist_path)
        except OSError:
            pass

        try:
            with open(blacklist_path, "r", encoding="utf-8") as f:
                entries = json.load(f)
        except FileNotFoundError:
            _log("No blacklist.json found, no terms loaded")
            self.blocked_terms = []
            self._blocked_regexes = []
            return
        except (json.JSONDecodeError, OSError) as e:
            _log(f"Error reading blacklist.json: {e}")
            return

        if not isinstance(entries, list):
            return

        terms = []
        regexes = []
        for entry in entries:
            if not isinstance(entry, str) or not entry.strip():
                continue
            entry = entry.strip()
            if entry.startswith("/"):
                # Parse /pattern/flags regex
                last_slash = entry.rfind("/", 1)
                if last_slash <= 0:
                    continue
                pattern = entry[1:last_slash]
                flags_str = entry[last_slash + 1:]
                flags = 0
                if "i" in flags_str:
                    flags |= re.IGNORECASE
                try:
                    regexes.append(re.compile(pattern, flags))
                except re.error as e:
                    _log(f"Invalid blacklist regex \"{entry}\": {e}")
            else:
                terms.append(entry.lower())

        self.blocked_terms = terms
        self._blocked_regexes = regexes
        total = len(terms) + len(regexes)
        _log(f"Loaded {total} blacklist entries ({len(terms)} text, {len(regexes)} regex)")

    def is_message_blocked(self, message):
        """Check if a message contains blocked terms. Returns (is_blocked, matched_term)."""
        if not self.blocked_terms and not self._blocked_regexes:
            return False, None

        message_lower = message.lower()
        for term in self.blocked_terms:
            if term in message_lower:
                return True, term

        for regex in self._blocked_regexes:
            if regex.search(message):
                return True, regex.pattern

        return False, None

    def refresh_blocked_terms_if_needed(self):
        """Re-load blacklist from file only if the file has been modified."""
        if self._blacklist_check_interval <= 0:
            return

        elapsed = time.time() - self._last_blacklist_check
        if elapsed < self._blacklist_check_interval:
            return

        self._last_blacklist_check = time.time()
        blacklist_path = _data_path("blacklist.json")

        try:
            mtime = os.path.getmtime(blacklist_path)
        except OSError:
            return

        if mtime != self._blacklist_mtime:
            old_count = len(self.blocked_terms) + len(self._blocked_regexes)
            self.fetch_blocked_terms()
            new_count = len(self.blocked_terms) + len(self._blocked_regexes)
            if new_count != old_count:
                _log(f"Blacklist updated: {old_count} -> {new_count} entries")
