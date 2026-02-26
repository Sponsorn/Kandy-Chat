"""YouTube to Twitch Chat Bot - Main coordinator."""

import json
import os
import time
import socket
import requests
from collections import defaultdict
from datetime import datetime, timezone


def log(msg=""):
    """Print with timestamp and immediate flush for Docker log visibility."""
    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    print(f"[{ts}] {msg}", flush=True)


# Spam protection defaults
RATE_LIMIT_WINDOW = 30  # seconds
RATE_LIMIT_MAX_MESSAGES = 3  # max messages per user per window
DUPLICATE_WINDOW = 30  # seconds — block identical messages from same user


class YouTubeToTwitchBot:
    """Coordinates YouTube chat reading and Twitch message sending."""

    def __init__(self, config):
        from youtube_reader import YouTubeChatReader
        from twitch_bot import TwitchBot

        self.youtube = YouTubeChatReader(config["youtube_channel_url"])

        self.twitch = TwitchBot(
            bot_user_id=config["twitch_bot_user_id"],
            oauth_token=config["twitch_oauth_token"],
            client_id=config["twitch_client_id"],
            channel_user_id=config["twitch_channel_user_id"],
            broadcaster_oauth_token=config.get("twitch_broadcaster_oauth_token") or None,
            client_secret=config.get("twitch_client_secret") or None,
            bot_refresh_token=config.get("twitch_bot_refresh_token") or None,
            broadcaster_refresh_token=config.get("twitch_broadcaster_refresh_token") or None,
        )

        self.message_format = config.get("message_format", "[YT] {author}: {message}")
        self.debug_mode = config.get("debug_mode", False)
        self.auto_restart = config.get("auto_restart", True)
        self.restart_delay = config.get("restart_delay", 30)
        self.blocked_terms_refresh_minutes = config.get("blocked_terms_refresh_minutes", 30)
        self.running = False

        from emoji_converter import EmojiConverter
        # ../data for local dev, ./data for Docker (/app/data)
        data_dir = os.path.join(os.path.dirname(__file__), "..", "data")
        if not os.path.isdir(data_dir):
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        self.emoji_converter = EmojiConverter(
            data_dir,
            reload_interval=300,
        )
        self.emoji_converter.reload()

        # Spam protection state — keyed by author name
        # _user_timestamps: { "Author": [timestamp, timestamp, ...] }
        # _user_last_message: { "Author": ("message text", timestamp) }
        self._user_timestamps = defaultdict(list)
        self._user_last_message = {}

    def _is_rate_limited(self, author):
        """Check if a user has exceeded the message rate limit.

        Returns True if the user sent more than RATE_LIMIT_MAX_MESSAGES
        in the last RATE_LIMIT_WINDOW seconds.
        """
        now = time.time()
        cutoff = now - RATE_LIMIT_WINDOW

        # Prune old timestamps
        timestamps = [t for t in self._user_timestamps[author] if t > cutoff]
        self._user_timestamps[author] = timestamps

        if len(timestamps) >= RATE_LIMIT_MAX_MESSAGES:
            return True

        self._user_timestamps[author].append(now)
        return False

    def _is_duplicate(self, author, message):
        """Check if this is a duplicate message from the same user.

        Returns True if the user sent the exact same message within
        DUPLICATE_WINDOW seconds.
        """
        now = time.time()
        last = self._user_last_message.get(author)

        if last:
            last_msg, last_time = last
            if last_msg == message and (now - last_time) < DUPLICATE_WINDOW:
                return True

        self._user_last_message[author] = (message, now)
        return False

    def _cleanup_spam_state(self):
        """Periodically clean up stale entries from spam tracking dicts."""
        now = time.time()
        cutoff = now - RATE_LIMIT_WINDOW

        # Clean up timestamps
        stale_users = [
            user for user, timestamps in self._user_timestamps.items()
            if not timestamps or timestamps[-1] < cutoff
        ]
        for user in stale_users:
            del self._user_timestamps[user]

        # Clean up last messages
        stale_msgs = [
            user for user, (_, ts) in self._user_last_message.items()
            if (now - ts) > DUPLICATE_WINDOW
        ]
        for user in stale_msgs:
            del self._user_last_message[user]

    def _read_stream_status(self):
        """Read live status from shared data/stream-status.json (written by main bot).

        Returns True if any channel is live, False otherwise.
        Returns False if the file is missing or unreadable (assume offline).
        """
        status_path = os.path.join(os.path.dirname(__file__), "..", "data", "stream-status.json")
        if not os.path.isfile(status_path):
            status_path = os.path.join(os.path.dirname(__file__), "data", "stream-status.json")

        try:
            with open(status_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return False

        for channel_name, info in data.items():
            if isinstance(info, dict) and info.get("live") is True:
                return True
        return False

    def wait_for_stream_start(self):
        """Wait for stream to go live by watching data/stream-status.json."""
        log("Waiting for stream to go live (watching stream-status.json)...")

        check_count = 0
        start_time = time.time()
        try:
            while self.running:
                check_count += 1
                if self._read_stream_status():
                    elapsed = int(time.time() - start_time)
                    log(f"Stream is now live! (detected after {elapsed}s)")
                    return True

                # Heartbeat every 60 checks (~10 min at 10s interval)
                if check_count % 60 == 0:
                    elapsed = int(time.time() - start_time)
                    minutes = elapsed // 60
                    log(f"   Still waiting for stream to go live ({minutes}m elapsed)")

                time.sleep(10)

        except KeyboardInterrupt:
            log("Cancelled waiting for stream")
            return False

        return False

    def start(self):
        """Start the bot."""
        log("=" * 60)
        log("YouTube to Twitch Chat Relay")
        log(f"   YouTube: {self.youtube.channel_url}")
        log(f"   Format:  {self.message_format}")
        log(f"   Rate limit: {RATE_LIMIT_MAX_MESSAGES} msgs/{RATE_LIMIT_WINDOW}s per user")
        log(f"   Duplicate window: {DUPLICATE_WINDOW}s")
        if self.debug_mode:
            log("   *** DEBUG MODE ENABLED ***")
        log("=" * 60)

        self.running = True

        # Wait for stream to go live
        if not self.debug_mode:
            if not self._read_stream_status():
                if not self.wait_for_stream_start():
                    log("Exiting...")
                    return

        # Connect to Twitch
        log("Connecting to Twitch...")
        self.twitch.connect()

        # Set blocked terms refresh interval
        refresh_seconds = self.blocked_terms_refresh_minutes * 60
        self.twitch._blacklist_check_interval = refresh_seconds

        # Start YouTube chat reader
        log(f"Starting YouTube chat reader: {self.youtube.channel_url}")
        self.youtube.start()

        log("Bot is now running!")

        was_live = True
        last_twitch_live_check = time.time()
        last_cleanup = time.time()
        offline_since = None

        try:
            while self.running:
                try:
                    # Periodically check stream status from file
                    if time.time() - last_twitch_live_check >= 10:
                        is_live = self._read_stream_status()
                        last_twitch_live_check = time.time()

                        if was_live and not is_live:
                            log("Stream went offline. Pausing relay.")
                            was_live = False
                            offline_since = time.time()
                            # Stop YouTube reader to avoid pointless scraping
                            self.youtube.stop()
                        elif not was_live and is_live:
                            elapsed = int(time.time() - offline_since) if offline_since else 0
                            log(f"Stream is back online! Resuming relay. (offline {elapsed}s)")
                            was_live = True
                            offline_since = None
                            # Restart YouTube reader
                            self.youtube.start()
                        elif not was_live and offline_since:
                            # Periodic heartbeat while offline (~10 min)
                            elapsed = int(time.time() - offline_since)
                            if elapsed > 0 and elapsed % 600 < 10:
                                minutes = elapsed // 60
                                log(f"   Still offline ({minutes}m). Waiting...")

                    # Periodically refresh blocked terms
                    self.twitch.refresh_blocked_terms_if_needed()

                    # Periodically clean up spam tracking state
                    if time.time() - last_cleanup > 60:
                        self._cleanup_spam_state()
                        last_cleanup = time.time()

                    # If stream is offline, don't consume messages
                    if not was_live:
                        time.sleep(1)
                        continue

                    # Read from YouTube chat queue
                    try:
                        msg = self.youtube.queue.get(timeout=1)
                    except Exception:
                        # queue.Empty — no messages, loop continues
                        continue

                    author = msg["author"]
                    message_text = msg["message"]

                    # Capitalize first letter
                    if message_text:
                        message_text = message_text[0].upper() + message_text[1:]

                    # Convert YouTube emojis
                    self.emoji_converter.reload_if_needed()
                    message_text = self.emoji_converter.convert(message_text)

                    # Spam protection: duplicate check
                    if self._is_duplicate(author, message_text):
                        log(f"[DUPLICATE] {author}: {message_text}")
                        continue

                    # Spam protection: rate limit check
                    if self._is_rate_limited(author):
                        log(f"[RATE LIMITED] {author}: {message_text}")
                        continue

                    formatted_msg = self.message_format.format(
                        author=author,
                        message=message_text,
                    )

                    # Truncate if too long (Twitch limit is 500 chars)
                    if len(formatted_msg) > 500:
                        formatted_msg = formatted_msg[:497] + "..."

                    # Check blocked terms
                    is_blocked, matched_term = self.twitch.is_message_blocked(formatted_msg)
                    if is_blocked:
                        log(f"[BLOCKED] {formatted_msg}")
                        log(f"   Reason: Contains blocked term '{matched_term}'")
                    else:
                        log(f"-> {formatted_msg}")
                        self.twitch.send_message(formatted_msg)

                    # Rate limit between messages
                    time.sleep(0.5)

                except (requests.exceptions.RequestException, socket.error, OSError) as e:
                    log(f"Connection error: {e}")
                    log("Attempting to reconnect in 10 seconds...")
                    time.sleep(10)
                    try:
                        self.twitch.disconnect()
                        self.twitch.connect()
                        log("Reconnected to Twitch")
                    except Exception as reconnect_error:
                        log(f"Reconnection failed: {reconnect_error}")
                        if not self.auto_restart:
                            raise

        except KeyboardInterrupt:
            log("Stopping bot...")
            self.running = False

        finally:
            self.youtube.stop()
            self.twitch.disconnect()
            log("Bot stopped.")
