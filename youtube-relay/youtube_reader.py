"""YouTube live chat reader using chat_downloader (no API key required)."""

import queue
import time
import threading
from chat_downloader import ChatDownloader


class YouTubeChatReader:
    """Reads YouTube live chat messages using chat_downloader.

    Runs in a background daemon thread, pushing messages onto a queue
    for the main loop to consume.
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

    def _read_loop(self):
        """Background loop: connect to chat, push messages to queue, reconnect on failure."""
        backoff = 5
        max_backoff = 300

        while self.running:
            try:
                print(f"Connecting to YouTube chat: {self.channel_url}")
                downloader = ChatDownloader()
                chat = downloader.get_chat(self.channel_url, message_types=["text_message"])

                backoff = 5  # Reset backoff on successful connection
                print("Connected to YouTube live chat")

                for message in chat:
                    if not self.running:
                        break

                    # Defensive filter: skip non-text messages that slip through
                    if message.get("message_type") != "text_message":
                        continue

                    author_name = message.get("author", {}).get("name", "Unknown")
                    text = message.get("message", "")

                    if text:
                        self.queue.put({"author": author_name, "message": text})

                # Iterator exhausted — stream ended
                if self.running:
                    print("YouTube chat stream ended. Reconnecting...")

            except Exception as e:
                if not self.running:
                    break
                print(f"YouTube chat error: {e}")

            # Backoff before retry
            if self.running:
                print(f"Retrying in {backoff}s...")
                time.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)
