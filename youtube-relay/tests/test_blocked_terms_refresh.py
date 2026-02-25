import time
from unittest.mock import patch, MagicMock


def test_refresh_blocked_terms_updates_when_file_changed():
    """refresh_blocked_terms_if_needed reloads when file mtime has changed."""
    from twitch_bot import TwitchBot

    bot = TwitchBot(
        bot_user_id="123",
        oauth_token="token",
        client_id="client",
        channel_user_id="456",
    )
    bot.blocked_terms = ["old_term"]
    bot._last_blacklist_check = time.time() - 1900  # 31+ minutes ago
    bot._blacklist_check_interval = 1800  # 30 minutes
    bot._blacklist_mtime = 1000  # Old mtime

    with patch("twitch_bot.os.path.getmtime", return_value=2000):  # New mtime
        with patch.object(bot, "fetch_blocked_terms") as mock_fetch:
            bot.refresh_blocked_terms_if_needed()
            mock_fetch.assert_called_once()


def test_refresh_blocked_terms_skips_when_interval_not_elapsed():
    """refresh_blocked_terms_if_needed does nothing if interval hasn't passed."""
    from twitch_bot import TwitchBot

    bot = TwitchBot(
        bot_user_id="123",
        oauth_token="token",
        client_id="client",
        channel_user_id="456",
    )
    bot.blocked_terms = ["old_term"]
    bot._last_blacklist_check = time.time()  # Just now
    bot._blacklist_check_interval = 1800

    with patch.object(bot, "fetch_blocked_terms") as mock_fetch:
        bot.refresh_blocked_terms_if_needed()
        mock_fetch.assert_not_called()


def test_refresh_blocked_terms_disabled_when_zero():
    """refresh_blocked_terms_if_needed does nothing when interval is 0."""
    from twitch_bot import TwitchBot

    bot = TwitchBot(
        bot_user_id="123",
        oauth_token="token",
        client_id="client",
        channel_user_id="456",
    )
    bot._last_blacklist_check = 0
    bot._blacklist_check_interval = 0  # Disabled

    with patch.object(bot, "fetch_blocked_terms") as mock_fetch:
        bot.refresh_blocked_terms_if_needed()
        mock_fetch.assert_not_called()


def test_refresh_skips_when_mtime_unchanged():
    """refresh_blocked_terms_if_needed skips reload when file hasn't changed."""
    from twitch_bot import TwitchBot

    bot = TwitchBot(
        bot_user_id="123",
        oauth_token="token",
        client_id="client",
        channel_user_id="456",
    )
    bot.blocked_terms = ["term"]
    bot._last_blacklist_check = time.time() - 1900
    bot._blacklist_check_interval = 1800
    bot._blacklist_mtime = 1000  # Same mtime

    with patch("twitch_bot.os.path.getmtime", return_value=1000):  # Unchanged
        with patch.object(bot, "fetch_blocked_terms") as mock_fetch:
            bot.refresh_blocked_terms_if_needed()
            mock_fetch.assert_not_called()
