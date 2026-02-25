import os
import pytest
from unittest.mock import patch


def test_load_config_returns_all_required_keys():
    """Config loader returns dict with all expected keys."""
    env_vars = {
        "YOUTUBE_CHANNEL_URL": "https://www.youtube.com/@TestChannel",
        "TWITCH_BOT_USER_ID": "123456",
        "TWITCH_OAUTH_TOKEN": "test_token",
        "TWITCH_CLIENT_ID": "test_client_id",
        "TWITCH_CHANNEL_USER_ID": "789012",
    }
    with patch.dict(os.environ, env_vars, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["youtube_channel_url"] == "https://www.youtube.com/@TestChannel"
        assert config["twitch_bot_user_id"] == "123456"
        assert config["twitch_oauth_token"] == "test_token"
        assert config["twitch_client_id"] == "test_client_id"
        assert config["twitch_channel_user_id"] == "789012"


def test_load_config_defaults():
    """Config loader provides sensible defaults for optional fields."""
    env_vars = {
        "YOUTUBE_CHANNEL_URL": "https://www.youtube.com/@TestChannel",
        "TWITCH_BOT_USER_ID": "123456",
        "TWITCH_OAUTH_TOKEN": "test_token",
        "TWITCH_CLIENT_ID": "test_client_id",
        "TWITCH_CHANNEL_USER_ID": "789012",
    }
    with patch.dict(os.environ, env_vars, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["message_format"] == "[YT] {author}: {message}"
        assert config["debug_mode"] is False
        assert config["auto_restart"] is True
        assert config["restart_delay"] == 30
        assert config["wait_for_twitch_live"] is True
        assert config["twitch_check_interval"] == 60
        assert config["skip_twitch_live_check"] is False
        assert config["blocked_terms_refresh_minutes"] == 30


def test_load_config_missing_required_raises():
    """Config loader raises ValueError when required env vars are missing."""
    with patch.dict(os.environ, {}, clear=True):
        from config_loader import load_config
        with pytest.raises(ValueError, match="YOUTUBE_CHANNEL_URL"):
            load_config()


def test_load_config_bool_parsing():
    """Config loader parses boolean strings correctly."""
    env_vars = {
        "YOUTUBE_CHANNEL_URL": "https://www.youtube.com/@TestChannel",
        "TWITCH_BOT_USER_ID": "123456",
        "TWITCH_OAUTH_TOKEN": "test_token",
        "TWITCH_CLIENT_ID": "test_client_id",
        "TWITCH_CHANNEL_USER_ID": "789012",
        "DEBUG_MODE": "true",
        "WAIT_FOR_TWITCH_LIVE": "false",
    }
    with patch.dict(os.environ, env_vars, clear=False):
        from config_loader import load_config
        config = load_config()
        assert config["debug_mode"] is True
        assert config["wait_for_twitch_live"] is False
