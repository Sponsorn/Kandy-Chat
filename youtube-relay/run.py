#!/usr/bin/env python3
"""
YouTube to Twitch Chat Relay - Entry Point
Loads configuration from .env file and starts the bot.
"""

import sys

try:
    from config_loader import load_config
except ImportError:
    print("Error: Could not import config_loader.")
    sys.exit(1)

try:
    from bot import YouTubeToTwitchBot
except ImportError:
    print("Error: Could not import bot.")
    sys.exit(1)


if __name__ == "__main__":
    try:
        config = load_config()
    except ValueError as e:
        print("=" * 60)
        print("ERROR: Configuration incomplete!")
        print("=" * 60)
        print(f"\n{e}")
        print("=" * 60)
        sys.exit(1)

    bot = YouTubeToTwitchBot(config)
    bot.start()
