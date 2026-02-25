"""YouTube to Twitch Chat Bot - Main coordinator."""

import os
import time
import socket
import requests
from collections import defaultdict


def log(msg=""):
    """Print with immediate flush for Docker log visibility."""
    print(msg, flush=True)


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
        self.wait_for_twitch_live_enabled = config.get("wait_for_twitch_live", True)
        self.twitch_check_interval = config.get("twitch_check_interval", 60)
        self.skip_twitch_live_check = config.get("skip_twitch_live_check", False)
        self.blocked_terms_refresh_minutes = config.get("blocked_terms_refresh_minutes", 30)
        self.running = False

        from emoji_converter import EmojiConverter
        self.emoji_converter = EmojiConverter(
            os.path.join(os.path.dirname(__file__), "..", "data"),
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

    def wait_for_stream_start(self):
        """Wait for Twitch channel to go live before starting YouTube polling."""
        log(f"Waiting for Twitch channel to go live...")
        log(f"   Checking every {self.twitch_check_interval}s")

        check_count = 0
        start_time = time.time()
        try:
            while self.running:
                check_count += 1
                is_live = self.twitch.is_channel_live()

                if is_live:
                    elapsed = int(time.time() - start_time)
                    log(f"Twitch channel is now live! (detected after {elapsed}s)")
                    return True

                elapsed = int(time.time() - start_time)
                minutes = elapsed // 60
                seconds = elapsed % 60
                if check_count % 5 == 0:
                    log(f"   Still waiting... ({minutes}m {seconds}s elapsed)")

                time.sleep(self.twitch_check_interval)

        except KeyboardInterrupt:
            log("Cancelled waiting for Twitch to go live")
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

        # Check Twitch live status
        if self.skip_twitch_live_check:
            log("Skipping Twitch live check")
        elif self.wait_for_twitch_live_enabled and not self.debug_mode:
            log("Smart polling enabled: Will wait for Twitch to go live")
            if not self.twitch.is_channel_live(debug=True):
                if not self.wait_for_stream_start():
                    log("Exiting...")
                    return
        elif not self.debug_mode:
            log("Checking Twitch channel status...")
            if not self.twitch.is_channel_live():
                log("Warning: Twitch channel is not live!")
                log("Messages will be relayed but may not be visible.")

        # Connect to Twitch
        log("Connecting to Twitch...")
        self.twitch.connect()

        # Set blocked terms refresh interval
        refresh_seconds = self.blocked_terms_refresh_minutes * 60
        self.twitch._blocked_terms_refresh_interval = refresh_seconds

        # Start YouTube chat reader
        log(f"Starting YouTube chat reader: {self.youtube.channel_url}")
        self.youtube.start()

        log("Bot is now running!")

        was_live = True
        last_twitch_live_check = time.time()
        last_cleanup = time.time()

        try:
            while self.running:
                try:
                    # Periodically check if Twitch is still live
                    if not self.skip_twitch_live_check and (
                        time.time() - last_twitch_live_check >= self.twitch_check_interval
                    ):
                        is_live = self.twitch.is_channel_live()
                        last_twitch_live_check = time.time()

                        if was_live and not is_live:
                            log("Twitch channel went offline! Pausing relay...")
                            was_live = False
                        elif not was_live and is_live:
                            log("Twitch channel is back online! Resuming relay...")
                            was_live = True

                    # Periodically refresh blocked terms
                    self.twitch.refresh_blocked_terms_if_needed()

                    # Periodically clean up spam tracking state
                    if time.time() - last_cleanup > 60:
                        self._cleanup_spam_state()
                        last_cleanup = time.time()

                    # If Twitch is offline, don't consume messages
                    if not was_live and not self.skip_twitch_live_check:
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
