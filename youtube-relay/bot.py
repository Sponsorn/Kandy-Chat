"""YouTube to Twitch Chat Bot - Main coordinator."""

import os
import time
import socket
import requests


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

    def wait_for_stream_start(self):
        """Wait for Twitch channel to go live before starting YouTube polling."""
        print(f"\nWaiting for Twitch channel to go live...")
        print(f"   Checking every {self.twitch_check_interval} seconds")
        print("   Press Ctrl+C to cancel\n")

        check_count = 0
        start_time = time.time()
        try:
            while self.running:
                check_count += 1
                is_live = self.twitch.is_channel_live()

                if is_live:
                    elapsed = int(time.time() - start_time)
                    print(f"\nTwitch channel is now live! (detected after {elapsed}s)")
                    return True

                elapsed = int(time.time() - start_time)
                minutes = elapsed // 60
                seconds = elapsed % 60
                if check_count % 3 == 0:
                    print(f"   Still waiting... ({minutes}m {seconds}s elapsed, checked {check_count} times)")

                time.sleep(self.twitch_check_interval)

        except KeyboardInterrupt:
            print("\n\nCancelled waiting for Twitch to go live")
            return False

        return False

    def start(self):
        """Start the bot."""
        print("=" * 60)
        print("YouTube to Twitch Chat Relay")
        if self.debug_mode:
            print("*** DEBUG MODE ENABLED ***")
        print("=" * 60)

        self.running = True

        # Check Twitch live status
        if self.skip_twitch_live_check:
            print("\nSkipping Twitch live check")
        elif self.wait_for_twitch_live_enabled and not self.debug_mode:
            print("\nSmart polling enabled: Will wait for Twitch to go live")
            if not self.twitch.is_channel_live(debug=True):
                if not self.wait_for_stream_start():
                    print("Exiting...")
                    return
        elif not self.debug_mode:
            print("\nChecking Twitch channel status...")
            if not self.twitch.is_channel_live():
                print("\nWarning: Twitch channel is not live!")
                print("Messages will be relayed but may not be visible.")

        # Connect to Twitch
        print("\nConnecting to Twitch...")
        self.twitch.connect()

        # Set blocked terms refresh interval
        refresh_seconds = self.blocked_terms_refresh_minutes * 60
        self.twitch._blocked_terms_refresh_interval = refresh_seconds

        # Start YouTube chat reader
        print(f"\nStarting YouTube chat reader: {self.youtube.channel_url}")
        self.youtube.start()

        print("\nBot is now running!")
        print("Press Ctrl+C to stop\n")

        was_live = True
        last_twitch_live_check = time.time()

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
                            print("\nTwitch channel went offline! Pausing relay...")
                            was_live = False
                        elif not was_live and is_live:
                            print("\nTwitch channel is back online! Resuming relay...")
                            was_live = True

                    # Periodically refresh blocked terms
                    self.twitch.refresh_blocked_terms_if_needed()

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

                    # Capitalize first letter
                    message_text = msg["message"]
                    if message_text:
                        message_text = message_text[0].upper() + message_text[1:]

                    # Convert YouTube emojis
                    self.emoji_converter.reload_if_needed()
                    message_text = self.emoji_converter.convert(message_text)

                    formatted_msg = self.message_format.format(
                        author=msg["author"],
                        message=message_text,
                    )

                    # Truncate if too long (Twitch limit is 500 chars)
                    if len(formatted_msg) > 500:
                        formatted_msg = formatted_msg[:497] + "..."

                    # Check blocked terms
                    is_blocked, matched_term = self.twitch.is_message_blocked(formatted_msg)
                    if is_blocked:
                        print(f"[BLOCKED] {formatted_msg}")
                        print(f"   Reason: Contains blocked term '{matched_term}'")
                    else:
                        print(f"-> {formatted_msg}")
                        self.twitch.send_message(formatted_msg)

                    # Rate limit between messages
                    time.sleep(0.5)

                except (requests.exceptions.RequestException, socket.error, OSError) as e:
                    print(f"\nConnection error: {e}")
                    print("Attempting to reconnect in 10 seconds...")
                    time.sleep(10)
                    try:
                        self.twitch.disconnect()
                        self.twitch.connect()
                        print("Reconnected to Twitch")
                    except Exception as reconnect_error:
                        print(f"Reconnection failed: {reconnect_error}")
                        if not self.auto_restart:
                            raise

        except KeyboardInterrupt:
            print("\n\nStopping bot...")
            self.running = False

        finally:
            self.youtube.stop()
            self.twitch.disconnect()
            print("Bot stopped.")
