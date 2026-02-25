"""Twitch API client for the YouTube relay (send-only, no chat reading)."""

import time
import requests
from typing import Optional, List


class TwitchBot:
    """Sends messages to Twitch chat via Helix API.

    Unlike a full chat bot, this only sends messages — it does not
    read Twitch chat or use WebSocket EventSub.
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
        self._last_blocked_terms_refresh = 0
        self._blocked_terms_refresh_interval = 0

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
                print(f"Token refresh failed: {response.status_code}", flush=True)
                return None

            data = response.json()
            print("Successfully refreshed OAuth token", flush=True)
            return (data["access_token"], data["refresh_token"])

        except requests.exceptions.RequestException as e:
            print(f"Token refresh error: {e}", flush=True)
            return None

    def validate_token(self):
        """Validate bot token, refresh if expired. Returns True if valid."""
        try:
            response = requests.get(
                "https://id.twitch.tv/oauth2/validate",
                headers={"Authorization": f"OAuth {self.oauth_token}"},
                timeout=5,
            )

            if response.status_code == 401 and self.bot_refresh_token:
                print("Bot token expired, attempting refresh...", flush=True)
                result = self.refresh_access_token(self.bot_refresh_token)
                if result:
                    self.oauth_token, self.bot_refresh_token = result
                    return True
                print("Failed to refresh bot token", flush=True)
                return False

            if response.status_code != 200:
                print(f"Token validation failed: {response.status_code}", flush=True)
                return False

            return True

        except requests.exceptions.RequestException as e:
            print(f"Token validation error: {e}", flush=True)
            return False

    # ── Connect / disconnect ──────────────────────────────────────

    def connect(self):
        """Validate tokens and fetch blocked terms."""
        if not self.validate_token():
            raise Exception("Bot OAuth token validation failed")

        # Sync broadcaster token to bot token if not separately configured
        if not self.broadcaster_oauth_token or self.broadcaster_oauth_token == self.oauth_token:
            self.broadcaster_oauth_token = self.oauth_token
        else:
            # Validate separate broadcaster token
            try:
                response = requests.get(
                    "https://id.twitch.tv/oauth2/validate",
                    headers={"Authorization": f"OAuth {self.broadcaster_oauth_token}"},
                    timeout=5,
                )
                if response.status_code == 401 and self.broadcaster_refresh_token:
                    result = self.refresh_access_token(self.broadcaster_refresh_token)
                    if result:
                        self.broadcaster_oauth_token, self.broadcaster_refresh_token = result
                    else:
                        print("Failed to refresh broadcaster token, using bot token", flush=True)
                        self.broadcaster_oauth_token = self.oauth_token
                elif response.status_code != 200:
                    print("Broadcaster token invalid, using bot token", flush=True)
                    self.broadcaster_oauth_token = self.oauth_token
            except requests.exceptions.RequestException:
                self.broadcaster_oauth_token = self.oauth_token

        # Fetch blocked terms
        self.fetch_blocked_terms()
        self._last_blocked_terms_refresh = time.time()

        print("Twitch API client ready", flush=True)

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
                print(f"Failed to send message: {response.status_code}", flush=True)
                error = response.json()
                print(f"  {error}", flush=True)

                # Token might have expired mid-session
                if response.status_code == 401 and self.bot_refresh_token:
                    print("Refreshing token and retrying...", flush=True)
                    result = self.refresh_access_token(self.bot_refresh_token)
                    if result:
                        self.oauth_token, self.bot_refresh_token = result
                        # Retry once
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
                        print(f"Retry failed: {retry.status_code}", flush=True)

        except requests.exceptions.RequestException as e:
            print(f"Error sending message: {e}", flush=True)

    # ── Channel status ────────────────────────────────────────────

    def is_channel_live(self):
        """Check if the Twitch channel is live."""
        try:
            response = requests.get(
                f"https://api.twitch.tv/helix/streams?user_id={self.channel_user_id}",
                headers={
                    "Authorization": f"Bearer {self.oauth_token}",
                    "Client-Id": self.client_id,
                },
                timeout=5,
            )
            response.raise_for_status()
            data = response.json()

            streams = data.get("data", [])
            if streams and streams[0].get("type") == "live":
                return True

            return False

        except requests.exceptions.RequestException as e:
            print(f"Could not check Twitch live status: {e}", flush=True)
            print("  Assuming channel is live and continuing...", flush=True)
            return True

    # ── Blocked terms ─────────────────────────────────────────────

    def fetch_blocked_terms(self):
        """Fetch blocked terms from Twitch channel."""
        all_terms = []
        cursor = None

        try:
            while True:
                url = (
                    f"https://api.twitch.tv/helix/moderation/blocked_terms"
                    f"?broadcaster_id={self.channel_user_id}"
                    f"&moderator_id={self.bot_user_id}&first=100"
                )
                if cursor:
                    url += f"&after={cursor}"

                response = requests.get(
                    url,
                    headers={
                        "Authorization": f"Bearer {self.broadcaster_oauth_token}",
                        "Client-Id": self.client_id,
                    },
                    timeout=5,
                )

                if response.status_code == 200:
                    data = response.json()
                    terms = [item["text"].lower() for item in data.get("data", [])]
                    all_terms.extend(terms)
                    cursor = data.get("pagination", {}).get("cursor")
                    if not cursor:
                        break
                elif response.status_code in (401, 403):
                    print(
                        f"Cannot fetch blocked terms ({response.status_code}). "
                        "Messages will not be filtered against Twitch blocked terms.",
                        flush=True,
                    )
                    return []
                else:
                    print(f"Failed to fetch blocked terms: {response.status_code}", flush=True)
                    return []

            self.blocked_terms = all_terms
            print(f"Loaded {len(all_terms)} blocked term(s) from Twitch", flush=True)
            return all_terms

        except requests.exceptions.RequestException as e:
            print(f"Error fetching blocked terms: {e}", flush=True)
            return []

    def is_message_blocked(self, message):
        """Check if a message contains blocked terms. Returns (is_blocked, matched_term)."""
        if not self.blocked_terms:
            return False, None

        message_lower = message.lower()
        for term in self.blocked_terms:
            if term in message_lower:
                return True, term
        return False, None

    def refresh_blocked_terms_if_needed(self):
        """Re-fetch blocked terms if the refresh interval has elapsed."""
        if self._blocked_terms_refresh_interval <= 0:
            return

        elapsed = time.time() - self._last_blocked_terms_refresh
        if elapsed >= self._blocked_terms_refresh_interval:
            old_count = len(self.blocked_terms)
            self.fetch_blocked_terms()
            self._last_blocked_terms_refresh = time.time()
            new_count = len(self.blocked_terms)
            if new_count != old_count:
                print(f"Blocked terms updated: {old_count} -> {new_count}", flush=True)
