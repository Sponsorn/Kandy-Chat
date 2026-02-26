"""Load bot configuration from environment variables."""

import os
from dotenv import load_dotenv


def _parse_bool(value):
    """Parse a string to boolean."""
    return value.lower() in ("true", "1", "yes")


def load_config():
    """
    Load configuration from environment variables.

    Returns:
        dict with all config values

    Raises:
        ValueError if required env vars are missing
    """
    load_dotenv()

    required = [
        "YOUTUBE_CHANNEL_URL",
        "TWITCH_BOT_USER_ID",
        "TWITCH_CLIENT_ID",
        "TWITCH_CHANNEL_USER_ID",
    ]

    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise ValueError(
            f"Missing required environment variables: {', '.join(missing)}\n"
            "Copy .env.example to .env and fill in your values."
        )

    # Auth is optional at config time — relay reads from shared data/tokens.json
    # at startup. Client secret + refresh token are kept as fallback if tokens.json
    # is unavailable (e.g. first run without main bot).

    return {
        "youtube_channel_url": os.environ["YOUTUBE_CHANNEL_URL"],
        "twitch_bot_user_id": os.environ["TWITCH_BOT_USER_ID"],
        "twitch_oauth_token": os.environ.get("TWITCH_OAUTH_TOKEN", ""),
        "twitch_client_id": os.environ["TWITCH_CLIENT_ID"],
        "twitch_client_secret": os.environ.get("TWITCH_CLIENT_SECRET", ""),
        "twitch_channel_user_id": os.environ["TWITCH_CHANNEL_USER_ID"],
        "twitch_broadcaster_oauth_token": os.environ.get("TWITCH_BROADCASTER_OAUTH_TOKEN", ""),
        "twitch_bot_refresh_token": os.environ.get("TWITCH_BOT_REFRESH_TOKEN", ""),
        "twitch_broadcaster_refresh_token": os.environ.get(
            "TWITCH_BROADCASTER_REFRESH_TOKEN", ""
        ),
        "message_format": os.environ.get("MESSAGE_FORMAT", "[YT] {author}: {message}"),
        "debug_mode": _parse_bool(os.environ.get("DEBUG_MODE", "false")),
        "auto_restart": _parse_bool(os.environ.get("AUTO_RESTART", "true")),
        "restart_delay": int(os.environ.get("RESTART_DELAY", "30")),
        "blocked_terms_refresh_minutes": int(
            os.environ.get("BLOCKED_TERMS_REFRESH_MINUTES", "30")
        ),
    }
