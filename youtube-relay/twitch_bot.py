"""Twitch bot using WebSocket EventSub for chat integration."""

import os
import time
import requests
import json
import threading
from typing import Optional, List
import websocket


class TwitchBot:
    """Handles connection and messaging to Twitch via WebSocket EventSub."""

    def __init__(self, bot_user_id: str, oauth_token: str, client_id: str, channel_user_id: str,
                 broadcaster_oauth_token: str = None, client_secret: str = None,
                 bot_refresh_token: str = None, broadcaster_refresh_token: str = None):
        """
        Initialize Twitch bot with WebSocket EventSub.

        Args:
            bot_user_id: The User ID of the chat bot
            oauth_token: Bot's OAuth token with scopes: user:bot, user:read:chat, user:write:chat
            client_id: Your application's Client ID
            channel_user_id: The User ID of the channel to send messages to
            broadcaster_oauth_token: Broadcaster's OAuth token with scope: channel:bot (optional, for Cloud Chatbot)
            client_secret: Your application's Client Secret (required for token refresh)
            bot_refresh_token: Bot's refresh token (optional, for automatic token renewal)
            broadcaster_refresh_token: Broadcaster's refresh token (optional, for automatic token renewal)
        """
        self.bot_user_id = bot_user_id
        self.oauth_token = oauth_token
        self.broadcaster_oauth_token = broadcaster_oauth_token or oauth_token  # Fallback to bot token if not provided
        self.client_id = client_id
        self.client_secret = client_secret
        self.bot_refresh_token = bot_refresh_token
        self.broadcaster_refresh_token = broadcaster_refresh_token
        self.channel_user_id = channel_user_id
        self.websocket_url = "wss://eventsub.wss.twitch.tv/ws"
        self.session_id = None
        self.ws = None
        self.connected = False
        self.running = False
        self.connection_count = 0  # Track number of connections for message rotation
        self.blocked_terms = []  # Cached list of blocked terms from Twitch
        self._last_blocked_terms_refresh = 0
        self._blocked_terms_refresh_interval = 0  # Set by main bot from config

    def fetch_blocked_terms(self) -> List[str]:
        """
        Fetch the list of blocked terms from Twitch channel.
        Requires moderator:read:blocked_terms scope on broadcaster token.

        Returns:
            List of blocked terms (lowercase)
        """
        all_terms = []
        cursor = None

        try:
            # Fetch all pages of blocked terms
            while True:
                url = f"https://api.twitch.tv/helix/moderation/blocked_terms?broadcaster_id={self.channel_user_id}&moderator_id={self.bot_user_id}&first=100"
                if cursor:
                    url += f"&after={cursor}"

                response = requests.get(
                    url,
                    headers={
                        'Authorization': f'Bearer {self.broadcaster_oauth_token}',
                        'Client-Id': self.client_id
                    },
                    timeout=5
                )

                if response.status_code == 200:
                    data = response.json()
                    terms = [item['text'].lower() for item in data.get('data', [])]
                    all_terms.extend(terms)

                    # Check if there are more pages
                    cursor = data.get('pagination', {}).get('cursor')
                    if not cursor:
                        break  # No more pages

                elif response.status_code == 401:
                    print("Unable to fetch blocked terms: Missing moderator:read:blocked_terms scope")
                    print("  Messages will not be filtered. Add scope to broadcaster token to enable filtering.")
                    return []
                elif response.status_code == 403:
                    print("Unable to fetch blocked terms: Bot is not a moderator in this channel")
                    print("  Messages will not be filtered.")
                    return []
                else:
                    print(f"Failed to fetch blocked terms: {response.status_code}")
                    try:
                        error_data = response.json()
                        print(f"  Error details: {error_data}")
                    except Exception:
                        print(f"  Response: {response.text}")
                    return []

            # Store all fetched terms
            self.blocked_terms = all_terms
            if all_terms:
                print(f"Loaded {len(all_terms)} blocked term(s) from Twitch")
            else:
                print("No blocked terms found in channel settings")
                print("  Make sure you've added blocked terms in Twitch Dashboard -> Settings -> Moderation")
            return all_terms

        except requests.exceptions.RequestException as e:
            print(f"Error fetching blocked terms: {e}")
            return []

    def is_message_blocked(self, message: str) -> tuple:
        """
        Check if a message contains any blocked terms.

        Args:
            message: The message to check

        Returns:
            Tuple of (is_blocked, matched_term)
        """
        if not self.blocked_terms:
            # No blocked terms loaded
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
                print(f"Blocked terms updated: {old_count} -> {new_count}")

    def is_channel_live(self, debug=False) -> bool:
        """
        Check if the Twitch channel is currently live.

        Args:
            debug: If True, print detailed API response for debugging

        Returns:
            True if channel is live, False otherwise
        """
        try:
            # Method 1: Use Twitch Helix API streams endpoint (most reliable)
            response = requests.get(
                f"https://api.twitch.tv/helix/streams?user_id={self.channel_user_id}",
                headers={
                    'Authorization': f'Bearer {self.oauth_token}',
                    'Client-Id': self.client_id
                },
                timeout=5
            )
            response.raise_for_status()
            data = response.json()

            if debug:
                print(f"[DEBUG] Streams API response: {json.dumps(data, indent=2)}")

            if data.get('data') and len(data['data']) > 0:
                stream_info = data['data'][0]
                stream_type = stream_info.get('type', '')
                title = stream_info.get('title', 'Untitled')

                if debug:
                    print(f"[DEBUG] Stream type: {stream_type}")
                    print(f"[DEBUG] Stream title: {title}")

                if stream_type == 'live':
                    print(f"Twitch channel is live: \"{title}\"")
                    return True

            # Get username for better error message
            user_response = requests.get(
                f"https://api.twitch.tv/helix/users?id={self.channel_user_id}",
                headers={
                    'Authorization': f'Bearer {self.oauth_token}',
                    'Client-Id': self.client_id
                },
                timeout=5
            )

            if user_response.status_code == 200:
                user_data = user_response.json()
                if user_data.get('data'):
                    channel_name = user_data['data'][0]['login']
                    print(f"Twitch channel '{channel_name}' is currently offline")
                    return False

            print(f"Twitch channel (ID: {self.channel_user_id}) is currently offline")
            return False

        except requests.exceptions.RequestException as e:
            print(f"Could not check Twitch live status: {e}")
            print("  Assuming channel is live and continuing...")
            return True

    def refresh_access_token(self, refresh_token: str) -> Optional[tuple]:
        """
        Refresh an OAuth access token using a refresh token.

        Args:
            refresh_token: The refresh token to use

        Returns:
            Tuple of (new_access_token, new_refresh_token) or None if refresh failed
        """
        if not self.client_secret or not refresh_token:
            return None

        try:
            response = requests.post(
                'https://id.twitch.tv/oauth2/token',
                data={
                    'client_id': self.client_id,
                    'client_secret': self.client_secret,
                    'grant_type': 'refresh_token',
                    'refresh_token': refresh_token
                },
                timeout=5
            )

            if response.status_code != 200:
                print(f"Token refresh failed with status {response.status_code}")
                print(f"  {response.json()}")
                return None

            data = response.json()
            new_access_token = data['access_token']
            new_refresh_token = data['refresh_token']

            print("Successfully refreshed OAuth token")
            return (new_access_token, new_refresh_token)

        except requests.exceptions.RequestException as e:
            print(f"Token refresh error: {e}")
            return None

    def validate_token(self) -> bool:
        """
        Validate the OAuth token, and refresh if expired.

        Returns:
            True if token is valid, False otherwise
        """
        try:
            response = requests.get(
                'https://id.twitch.tv/oauth2/validate',
                headers={'Authorization': f'OAuth {self.oauth_token}'},
                timeout=5
            )

            if response.status_code == 401 and self.bot_refresh_token:
                # Token expired, try to refresh
                print("Bot token expired, attempting refresh...")
                result = self.refresh_access_token(self.bot_refresh_token)
                if result:
                    self.oauth_token, self.bot_refresh_token = result
                    print("Bot OAuth token refreshed and validated successfully")
                    return True
                else:
                    print("Failed to refresh bot token")
                    return False

            if response.status_code != 200:
                print(f"Token validation failed with status {response.status_code}")
                print(f"  {response.json()}")
                return False

            print("OAuth token validated successfully")
            return True

        except requests.exceptions.RequestException as e:
            print(f"Token validation error: {e}")
            return False

    def validate_broadcaster_token(self) -> bool:
        """
        Validate the broadcaster's OAuth token, and refresh if expired.

        Returns:
            True if token is valid, False otherwise
        """
        if self.broadcaster_oauth_token == self.oauth_token:
            # Using same token, already validated
            return True

        try:
            response = requests.get(
                'https://id.twitch.tv/oauth2/validate',
                headers={'Authorization': f'OAuth {self.broadcaster_oauth_token}'},
                timeout=5
            )

            if response.status_code == 401 and self.broadcaster_refresh_token:
                # Token expired, try to refresh
                print("Broadcaster token expired, attempting refresh...")
                result = self.refresh_access_token(self.broadcaster_refresh_token)
                if result:
                    self.broadcaster_oauth_token, self.broadcaster_refresh_token = result
                    print("Broadcaster OAuth token refreshed and validated successfully")
                    return True
                else:
                    print("Failed to refresh broadcaster token")
                    return False

            if response.status_code != 200:
                print(f"Broadcaster token validation failed with status {response.status_code}")
                print(f"  {response.json()}")
                return False

            print("Broadcaster OAuth token validated successfully")
            return True

        except requests.exceptions.RequestException as e:
            print(f"Broadcaster token validation error: {e}")
            return False

    def connect(self):
        """Connect to Twitch WebSocket EventSub."""
        print("Connecting to Twitch WebSocket EventSub...")

        # Validate bot token first
        if not self.validate_token():
            raise Exception("Bot OAuth token validation failed")

        # Validate broadcaster token (if different from bot token)
        if not self.validate_broadcaster_token():
            raise Exception("Broadcaster OAuth token validation failed")

        # Create WebSocket connection
        self.ws = websocket.WebSocketApp(
            self.websocket_url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close
        )

        # Run WebSocket in a separate thread
        self.running = True
        self.ws_thread = threading.Thread(target=self.ws.run_forever, daemon=True)
        self.ws_thread.start()

        # Wait for connection to be established
        timeout = 10
        start_time = time.time()
        while not self.connected and (time.time() - start_time) < timeout:
            time.sleep(0.1)

        if not self.connected:
            raise Exception("Failed to connect to Twitch WebSocket within timeout")

        print("Connected to Twitch WebSocket EventSub")

        # Fetch blocked terms from Twitch
        self.fetch_blocked_terms()
        self._last_blocked_terms_refresh = time.time()

    def _on_open(self, ws):
        """WebSocket connection opened."""
        print("WebSocket connection opened")

    def _on_message(self, ws, message):
        """Handle incoming WebSocket messages."""
        try:
            data = json.loads(message)
            message_type = data.get('metadata', {}).get('message_type')

            if message_type == 'session_welcome':
                # First message - get session ID
                self.session_id = data['payload']['session']['id']
                print(f"Received session ID: {self.session_id}")
                self.connected = True

                # Register EventSub listeners
                self._register_eventsub_listeners()

            elif message_type == 'notification':
                # We don't need to handle incoming messages for this bot
                # (we only send messages, not receive them)
                pass

            elif message_type == 'session_keepalive':
                # Keep-alive message, no action needed
                pass

            elif message_type == 'session_reconnect':
                # Server wants us to reconnect
                print("Server requested reconnection")
                reconnect_url = data['payload']['session']['reconnect_url']
                # Would need to handle reconnection here
                pass

        except json.JSONDecodeError as e:
            print(f"Failed to parse WebSocket message: {e}")
        except Exception as e:
            print(f"Error handling WebSocket message: {e}")

    def _on_error(self, ws, error):
        """WebSocket error occurred."""
        print(f"WebSocket error: {error}")

    def _on_close(self, ws, close_status_code, close_msg):
        """WebSocket connection closed."""
        self.connected = False
        print(f"WebSocket connection closed: {close_status_code} - {close_msg}")

    def _register_eventsub_listeners(self):
        """Register EventSub subscriptions for channel.chat.message."""
        try:
            # Use broadcaster's token for EventSub subscription (required for Cloud Chatbot)
            response = requests.post(
                'https://api.twitch.tv/helix/eventsub/subscriptions',
                headers={
                    'Authorization': f'Bearer {self.broadcaster_oauth_token}',
                    'Client-Id': self.client_id,
                    'Content-Type': 'application/json'
                },
                json={
                    'type': 'channel.chat.message',
                    'version': '1',
                    'condition': {
                        'broadcaster_user_id': self.channel_user_id,
                        'user_id': self.bot_user_id
                    },
                    'transport': {
                        'method': 'websocket',
                        'session_id': self.session_id
                    }
                }
            )

            if response.status_code != 202:
                print(f"Failed to subscribe to channel.chat.message: {response.status_code}")
                print(f"  {response.json()}")
            else:
                data = response.json()
                subscription_id = data['data'][0]['id']
                print(f"Subscribed to channel.chat.message [{subscription_id}]")

                # Get channel name for confirmation message
                user_response = requests.get(
                    f"https://api.twitch.tv/helix/users?id={self.channel_user_id}",
                    headers={
                        'Authorization': f'Bearer {self.oauth_token}',
                        'Client-Id': self.client_id
                    },
                    timeout=5
                )

                if user_response.status_code == 200:
                    user_data = user_response.json()
                    if user_data.get('data'):
                        channel_name = user_data['data'][0]['login']
                        print(f"Connected to Twitch channel: {channel_name}")

                        # Send fun connection message to chat
                        time.sleep(0.5)  # Small delay to ensure connection is ready

                        # Fun alternating messages
                        messages = [
                            "Hi, I'm a bot!",
                            "Honk honk, I'm here!",
                            "Bot is online. Let's relay.",
                            "Bot online.",
                            "Found twitch, I hope you started YouTube live as well.",
                            "KandyIand is live, checking for YouTube."
                        ]

                        # Load last message index from file (persists across restarts)
                        counter_file = '.bot_message_counter'
                        try:
                            if os.path.exists(counter_file):
                                with open(counter_file, 'r') as f:
                                    self.connection_count = int(f.read().strip())
                        except (ValueError, IOError):
                            self.connection_count = 0

                        # Rotate through messages
                        message = messages[self.connection_count % len(messages)]
                        self.connection_count += 1

                        # Save counter for next restart
                        try:
                            with open(counter_file, 'w') as f:
                                f.write(str(self.connection_count))
                        except IOError:
                            pass  # Ignore if we can't write

                        self.send_message(message)

        except requests.exceptions.RequestException as e:
            print(f"Error registering EventSub listeners: {e}")

    def send_message(self, message: str):
        """Send a message to the Twitch channel."""
        try:
            response = requests.post(
                'https://api.twitch.tv/helix/chat/messages',
                headers={
                    'Authorization': f'Bearer {self.oauth_token}',
                    'Client-Id': self.client_id,
                    'Content-Type': 'application/json'
                },
                json={
                    'broadcaster_id': self.channel_user_id,
                    'sender_id': self.bot_user_id,
                    'message': message
                },
                timeout=5
            )

            if response.status_code != 200:
                print(f"Failed to send chat message: {response.status_code}")
                print(f"  {response.json()}")
            # Don't print success message for every sent message to reduce spam

        except requests.exceptions.RequestException as e:
            print(f"Error sending chat message: {e}")

    def ping_pong(self):
        """No-op for WebSocket (keepalive is handled automatically)."""
        pass

    def disconnect(self):
        """Disconnect from Twitch WebSocket."""
        self.running = False
        if self.ws:
            self.ws.close()
            print("Disconnected from Twitch WebSocket")
