"""YouTube live chat reader using yt-dlp and YouTube innertube API."""

import json
import queue
import re
import time
import threading
import requests
import yt_dlp
from datetime import datetime, timezone


# YouTube innertube (public, no auth required)
_INNERTUBE_CONTEXT = {
    "client": {
        "clientName": "WEB",
        "clientVersion": "2.20250101.00.00",
    }
}


def _log(msg):
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    print(f"[{ts}] {msg}", flush=True)


class YouTubeChatReader:
    """Reads YouTube live chat messages.

    Uses yt-dlp to find the live stream, then polls YouTube's
    innertube API for chat messages. No API key required.
    """

    def __init__(self, channel_url):
        self.channel_url = channel_url
        self.queue = queue.Queue()
        self.running = False
        self._thread = None

    def start(self):
        """Start the background chat reader thread."""
        self.running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Signal the reader thread to stop."""
        self.running = False

    def _find_live_video_id(self):
        """Use yt-dlp to find the active live stream video ID."""
        url = self.channel_url
        if not url.endswith("/live"):
            url = url.rstrip("/") + "/live"

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            if not info:
                return None

            if not info.get("is_live"):
                return None

            return info.get("id")

    def _get_initial_chat_data(self, video_id):
        """Fetch the live chat page and extract continuation + API key."""
        resp = requests.get(
            f"https://www.youtube.com/live_chat?v={video_id}",
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
            },
            cookies={"CONSENT": "YES+cb"},
            timeout=10,
        )
        resp.raise_for_status()
        text = resp.text

        # Extract API key from ytcfg
        api_key = None
        key_match = re.search(r'"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"', text)
        if key_match:
            api_key = key_match.group(1)

        # Extract ytInitialData
        data_match = re.search(
            r'(?:window\s*\[\s*["\']ytInitialData["\']\s*\]|var\s+ytInitialData)\s*=\s*',
            text,
        )
        if not data_match:
            raise Exception("Could not find ytInitialData in live chat page")

        decoder = json.JSONDecoder()
        initial_data, _ = decoder.raw_decode(text, data_match.end())

        # Navigate to continuation token
        renderer = initial_data.get("contents", {}).get("liveChatRenderer", {})
        continuations = renderer.get("continuations", [])

        if not continuations:
            raise Exception("No continuations found in live chat data")

        continuation = None
        for cont in continuations:
            for key in ("invalidationContinuationData", "timedContinuationData",
                        "reloadContinuationData"):
                if key in cont:
                    continuation = cont[key].get("continuation")
                    if continuation:
                        break
            if continuation:
                break

        if not continuation:
            raise Exception("Could not extract continuation token")

        return continuation, api_key

    def _poll_chat(self, continuation, api_key):
        """Poll for new chat messages.

        Returns (messages, new_continuation, timeout_ms).
        """
        url = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
        if api_key:
            url += f"?key={api_key}"

        resp = requests.post(
            url,
            json={
                "context": _INNERTUBE_CONTEXT,
                "continuation": continuation,
            },
            headers={
                "Content-Type": "application/json",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        messages = []
        new_continuation = None
        timeout_ms = 5000

        # Extract continuation and poll interval
        live_chat = data.get("continuationContents", {}).get("liveChatContinuation", {})

        for cont in live_chat.get("continuations", []):
            for key in ("invalidationContinuationData", "timedContinuationData"):
                if key in cont:
                    new_continuation = cont[key].get("continuation")
                    timeout_ms = cont[key].get("timeoutMs", 5000)
                    break
            if new_continuation:
                break

        # Extract chat messages
        for action in live_chat.get("actions", []):
            item = action.get("addChatItemAction", {}).get("item", {})
            renderer = item.get("liveChatTextMessageRenderer")
            if not renderer:
                continue

            author = renderer.get("authorName", {}).get("simpleText", "Unknown")

            # Build message text from runs
            runs = renderer.get("message", {}).get("runs", [])
            parts = []
            for run in runs:
                if "text" in run:
                    parts.append(run["text"])
                elif "emoji" in run:
                    emoji = run["emoji"]
                    shortcuts = emoji.get("shortcuts", [])
                    if shortcuts:
                        parts.append(shortcuts[0])
                    else:
                        label = (
                            emoji.get("image", {})
                            .get("accessibility", {})
                            .get("accessibilityData", {})
                            .get("label", "")
                        )
                        if label:
                            parts.append(f":{label}:")

            text = "".join(parts).strip()
            if text:
                messages.append({"author": author, "message": text})

        return messages, new_continuation, timeout_ms

    def _read_loop(self):
        """Background loop: find stream, connect to chat, poll for messages."""
        backoff = 5
        max_backoff = 300

        while self.running:
            try:
                _log(f"Finding live stream: {self.channel_url}")
                video_id = self._find_live_video_id()

                if not video_id:
                    raise Exception("No active live stream found")

                _log(f"Found live stream: {video_id}")

                # Get initial continuation token
                continuation, api_key = self._get_initial_chat_data(video_id)
                _log("Connected to YouTube live chat")

                backoff = 5

                # Poll loop
                while self.running and continuation:
                    messages, new_continuation, timeout_ms = self._poll_chat(
                        continuation, api_key
                    )

                    for msg in messages:
                        self.queue.put(msg)

                    if not new_continuation:
                        _log("Chat stream ended (no continuation)")
                        break

                    continuation = new_continuation

                    # Respect YouTube's suggested poll interval
                    sleep_time = max(timeout_ms / 1000, 1.0)
                    end_time = time.time() + sleep_time
                    while self.running and time.time() < end_time:
                        time.sleep(0.5)

                if self.running:
                    _log("YouTube chat ended. Reconnecting...")

            except Exception as e:
                if not self.running:
                    break
                _log(f"YouTube chat error: {e}")

            # Backoff before retry
            if self.running:
                _log(f"Retrying in {backoff}s...")
                time.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)
