"""YouTube live chat reader using yt-dlp and YouTube innertube API."""

import json
import queue
import re
import time
import threading
from collections import deque
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

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

# (connect, read) timeouts for HTTP calls to YouTube
_HTTP_TIMEOUT = (5, 15)

# How many times a poll may fail in a row (same continuation token) before we
# give up on the session and rediscover the stream.
_MAX_POLL_FAILURES = 5
_POLL_RETRY_DELAYS = [2, 4, 8, 15, 30]

# Flat wait while the channel has no live stream (Twitch may be live before YouTube)
_NO_STREAM_WAIT = 30

# Backoff for real errors (network down, yt-dlp broken, ...)
_ERROR_BACKOFF_START = 5
_ERROR_BACKOFF_MAX = 120

# Log a heartbeat this often while connected
_HEARTBEAT_INTERVAL = 300

# Remember this many message ids to drop replays after a reconnect
_SEEN_IDS_MAX = 1000


def _log(msg):
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    print(f"[{ts}] {msg}", flush=True)


_SHORTCODE_RE = re.compile(r"^:[a-zA-Z0-9_-]+:$")


def _render_emoji_run(emoji):
    """Turn an innertube emoji run into text.

    Preference order:
    1. an ASCII shortcode such as ``:heart:`` (so emoji-mappings.json applies)
    2. the plain Unicode emoji when YouTube gives one and it is not a custom
       channel emoji, e.g. flags, which have no ASCII shortcode
    3. the accessibility label, wrapped in colons only when it is ASCII
    """
    shortcuts = emoji.get("shortcuts") or []
    for shortcut in shortcuts:
        if isinstance(shortcut, str) and _SHORTCODE_RE.match(shortcut):
            return shortcut

    emoji_id = emoji.get("emojiId") or ""
    is_custom = bool(emoji.get("isCustomEmoji")) or "/" in emoji_id
    if emoji_id and not is_custom and not emoji_id.isascii():
        return emoji_id

    label = (
        emoji.get("image", {})
        .get("accessibility", {})
        .get("accessibilityData", {})
        .get("label", "")
    )
    if not label:
        return shortcuts[0] if shortcuts else ""
    if label.isascii():
        return f":{label.strip().replace(' ', '_')}:"
    return label


class TransientPollError(Exception):
    """A poll failed in a way that is worth retrying with the same token."""


class YouTubeChatReader:
    """Reads YouTube live chat messages.

    Uses yt-dlp to find the live stream, then polls YouTube's
    innertube API for chat messages. No API key required.

    Resilience:
    - transient poll errors (timeouts, 5xx, 429, bad JSON, missing
      continuation) retry the same continuation token a few times before the
      stream is rediscovered, so a hiccup does not lose the chat position
    - on rediscovery the last known video id is tried first, yt-dlp only runs
      when that fails
    - a channel with no live stream is polled at a flat interval instead of
      exponential backoff
    - each start() creates a fresh stop event and generation number, so a
      stop()/start() cycle can never leave two reader threads feeding the queue
    - message ids are remembered so a reconnect does not replay messages
    """

    def __init__(self, channel_url):
        self.channel_url = channel_url
        self.queue = queue.Queue()
        self.running = False
        self._thread = None
        self._stop_event = threading.Event()
        self._generation = 0
        self._last_video_id = None
        self._seen_ids = set()
        self._seen_order = deque()
        # Stats for logging / debugging
        self.stats = {
            "polls": 0,
            "messages": 0,
            "reconnects": 0,
            "poll_retries": 0,
            "last_message_at": None,
            "connected_at": None,
        }

    # ------------------------------------------------------------------ lifecycle

    def start(self):
        """Start the background chat reader thread."""
        if self._thread and self._thread.is_alive():
            self.stop()
            self._thread.join(timeout=10)
            if self._thread.is_alive():
                _log("Previous YouTube reader thread still busy; it will exit on its own")

        self._generation += 1
        self._stop_event = threading.Event()
        self.running = True

        # Clear the queue so stale messages from before offline aren't relayed
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except Exception:
                break

        self._thread = threading.Thread(
            target=self._read_loop,
            args=(self._generation, self._stop_event),
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        """Signal the reader thread to stop."""
        self.running = False
        self._stop_event.set()

    # ------------------------------------------------------------------ discovery

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
            headers={"User-Agent": _USER_AGENT},
            cookies={"CONSENT": "YES+cb"},
            timeout=_HTTP_TIMEOUT,
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

    # ------------------------------------------------------------------ polling

    def _remember_id(self, msg_id):
        """Return True if the id is new, False if it was seen recently."""
        if not msg_id:
            return True
        if msg_id in self._seen_ids:
            return False
        self._seen_ids.add(msg_id)
        self._seen_order.append(msg_id)
        while len(self._seen_order) > _SEEN_IDS_MAX:
            old = self._seen_order.popleft()
            self._seen_ids.discard(old)
        return True

    def _poll_chat(self, continuation, api_key):
        """Poll for new chat messages.

        Returns (messages, new_continuation, timeout_ms).
        Raises TransientPollError for failures worth retrying with the same token.
        """
        url = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
        if api_key:
            url += f"?key={api_key}"

        try:
            resp = requests.post(
                url,
                json={
                    "context": _INNERTUBE_CONTEXT,
                    "continuation": continuation,
                },
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": _USER_AGENT,
                },
                timeout=_HTTP_TIMEOUT,
            )
        except requests.exceptions.RequestException as e:
            raise TransientPollError(f"request failed: {e.__class__.__name__}: {e}") from e

        status = getattr(resp, "status_code", 200)
        if isinstance(status, int) and (status == 429 or status >= 500):
            raise TransientPollError(f"HTTP {status}")
        resp.raise_for_status()

        try:
            data = resp.json()
        except ValueError as e:
            raise TransientPollError(f"invalid JSON: {e}") from e

        messages = []
        new_continuation = None
        timeout_ms = 5000

        # Extract continuation and poll interval
        live_chat = data.get("continuationContents", {}).get("liveChatContinuation", {})

        for cont in live_chat.get("continuations", []):
            for key in ("invalidationContinuationData", "timedContinuationData",
                        "reloadContinuationData"):
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

            if not self._remember_id(renderer.get("id")):
                continue

            author = renderer.get("authorName", {}).get("simpleText", "Unknown")

            # Build message text from runs
            runs = renderer.get("message", {}).get("runs", [])
            parts = []
            for run in runs:
                if "text" in run:
                    parts.append(run["text"])
                elif "emoji" in run:
                    parts.append(_render_emoji_run(run["emoji"]))

            text = "".join(parts).strip()
            if text:
                messages.append({"author": author, "message": text})

        return messages, new_continuation, timeout_ms

    # ------------------------------------------------------------------ main loop

    def _wait(self, stop_event, seconds):
        """Sleep that returns early when the reader is stopped."""
        return stop_event.wait(seconds)

    def _connect(self):
        """Find the live stream and get an initial continuation.

        Returns (video_id, continuation, api_key) or None if there is no live stream.
        """
        # Fast path: the stream we were reading is probably still the same one
        if self._last_video_id:
            try:
                continuation, api_key = self._get_initial_chat_data(self._last_video_id)
                _log(f"Reattached to live chat for {self._last_video_id}")
                return self._last_video_id, continuation, api_key
            except Exception as e:
                _log(f"Could not reattach to {self._last_video_id} ({e}); rediscovering")
                self._last_video_id = None

        _log(f"Finding live stream: {self.channel_url}")
        video_id = self._find_live_video_id()
        if not video_id:
            return None

        _log(f"Found live stream: {video_id}")
        continuation, api_key = self._get_initial_chat_data(video_id)
        self._last_video_id = video_id
        return video_id, continuation, api_key

    def _session(self, generation, stop_event, continuation, api_key):
        """Poll one chat session until it ends or the reader is stopped.

        Returns a short reason string for logging.
        """
        failures = 0
        polls = 0
        received = 0
        last_heartbeat = time.time()

        while not stop_event.is_set():
            try:
                messages, new_continuation, timeout_ms = self._poll_chat(continuation, api_key)
            except TransientPollError as e:
                failures += 1
                self.stats["poll_retries"] += 1
                if failures > _MAX_POLL_FAILURES:
                    return f"gave up after {failures} consecutive poll failures ({e})"
                delay = _POLL_RETRY_DELAYS[min(failures - 1, len(_POLL_RETRY_DELAYS) - 1)]
                _log(f"YouTube poll failed ({e}); retrying same position in {delay}s "
                     f"({failures}/{_MAX_POLL_FAILURES})")
                if self._wait(stop_event, delay):
                    return "stopped"
                continue

            polls += 1
            self.stats["polls"] += 1

            # Only the newest reader generation may feed the queue
            if generation != self._generation:
                return "superseded by a newer reader"

            for msg in messages:
                self.queue.put(msg)
            if messages:
                received += len(messages)
                self.stats["messages"] += len(messages)
                self.stats["last_message_at"] = time.time()

            if not new_continuation:
                failures += 1
                if failures > _MAX_POLL_FAILURES:
                    return "no continuation token returned repeatedly (chat ended?)"
                delay = _POLL_RETRY_DELAYS[min(failures - 1, len(_POLL_RETRY_DELAYS) - 1)]
                _log(f"YouTube poll returned no continuation; retrying same position in {delay}s "
                     f"({failures}/{_MAX_POLL_FAILURES})")
                if self._wait(stop_event, delay):
                    return "stopped"
                continue

            failures = 0
            continuation = new_continuation

            now = time.time()
            if now - last_heartbeat >= _HEARTBEAT_INTERVAL:
                last_heartbeat = now
                age = (
                    f"{int(now - self.stats['last_message_at'])}s ago"
                    if self.stats["last_message_at"]
                    else "never"
                )
                _log(f"YouTube chat heartbeat: {polls} polls, {received} messages this session, "
                     f"last message {age}")

            # Respect YouTube's suggested poll interval
            sleep_time = max(timeout_ms / 1000, 1.0)
            if self._wait(stop_event, sleep_time):
                return "stopped"

        return "stopped"

    def _read_loop(self, generation, stop_event):
        """Background loop: find stream, connect to chat, poll for messages."""
        error_backoff = _ERROR_BACKOFF_START

        while not stop_event.is_set():
            try:
                connected = self._connect()
            except Exception as e:
                _log(f"YouTube chat error: {e.__class__.__name__}: {e}")
                _log(f"Retrying in {error_backoff}s...")
                if self._wait(stop_event, error_backoff):
                    break
                error_backoff = min(error_backoff * 2, _ERROR_BACKOFF_MAX)
                continue

            if connected is None:
                _log(f"No active YouTube live stream found; checking again in {_NO_STREAM_WAIT}s")
                if self._wait(stop_event, _NO_STREAM_WAIT):
                    break
                continue

            video_id, continuation, api_key = connected
            _log("Connected to YouTube live chat")
            error_backoff = _ERROR_BACKOFF_START
            self.stats["connected_at"] = time.time()

            try:
                reason = self._session(generation, stop_event, continuation, api_key)
            except Exception as e:
                reason = f"unexpected error: {e.__class__.__name__}: {e}"

            duration = int(time.time() - self.stats["connected_at"])
            if stop_event.is_set() or reason == "superseded by a newer reader":
                _log(f"YouTube chat session ended after {duration}s ({reason})")
                break

            self.stats["reconnects"] += 1
            _log(f"YouTube chat session ended after {duration}s ({reason}). Reconnecting...")
            if self._wait(stop_event, 2):
                break

        _log("YouTube chat reader stopped")
