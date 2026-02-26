import os
import pytest
from unittest.mock import patch


# Minimal env with refresh-based auth (no TWITCH_OAUTH_TOKEN)
BASE_ENV = {
    "YOUTUBE_CHANNEL_URL": "https://www.youtube.com/@TestChannel",
    "TWITCH_BOT_USER_ID": "123456",
    "TWITCH_CLIENT_ID": "test_client_id",
    "TWITCH_CLIENT_SECRET": "test_secret",
    "TWITCH_BOT_REFRESH_TOKEN": "test_refresh",
    "TWITCH_CHANNEL_USER_ID": "789012",
}


def test_load_config_returns_all_required_keys():
    """Config loader returns dict with all expected keys."""
    with patch.dict(os.environ, BASE_ENV, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["youtube_channel_url"] == "https://www.youtube.com/@TestChannel"
        assert config["twitch_bot_user_id"] == "123456"
        assert config["twitch_client_id"] == "test_client_id"
        assert config["twitch_channel_user_id"] == "789012"


def test_load_config_defaults():
    """Config loader provides sensible defaults for optional fields."""
    with patch.dict(os.environ, BASE_ENV, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["message_format"] == "[YT] {author}: {message}"
        assert config["debug_mode"] is False
        assert config["auto_restart"] is True
        assert config["restart_delay"] == 30
        assert config["blocked_terms_refresh_minutes"] == 30


def test_load_config_missing_required_raises():
    """Config loader raises ValueError when required env vars are missing."""
    with patch.dict(os.environ, {}, clear=True):
        from config_loader import load_config
        with pytest.raises(ValueError, match="YOUTUBE_CHANNEL_URL"):
            load_config()


def test_load_config_no_auth_still_works():
    """Config loader accepts no auth tokens (relay reads from shared tokens.json)."""
    env = {
        "YOUTUBE_CHANNEL_URL": "https://www.youtube.com/@TestChannel",
        "TWITCH_BOT_USER_ID": "123456",
        "TWITCH_CLIENT_ID": "test_client_id",
        "TWITCH_CHANNEL_USER_ID": "789012",
    }
    with patch.dict(os.environ, env, clear=False):
        with patch("config_loader.os.environ.get") as mock_get:
            # Simulate missing auth by returning empty for auth keys
            def side_effect(key, default=""):
                if key in env:
                    return env[key]
                return default
            mock_get.side_effect = side_effect
            # No ValueError should be raised — auth is optional
            from config_loader import load_config
            config = load_config()
            assert "twitch_oauth_token" in config


def test_load_config_oauth_token_only():
    """Config loader accepts just TWITCH_OAUTH_TOKEN without refresh credentials."""
    env = {
        "YOUTUBE_CHANNEL_URL": "https://www.youtube.com/@TestChannel",
        "TWITCH_BOT_USER_ID": "123456",
        "TWITCH_OAUTH_TOKEN": "test_token",
        "TWITCH_CLIENT_ID": "test_client_id",
        "TWITCH_CHANNEL_USER_ID": "789012",
    }
    with patch.dict(os.environ, env, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["twitch_oauth_token"] == "test_token"


def test_load_config_bool_parsing():
    """Config loader parses boolean strings correctly."""
    env = {
        **BASE_ENV,
        "DEBUG_MODE": "true",
    }
    with patch.dict(os.environ, env, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["debug_mode"] is True
