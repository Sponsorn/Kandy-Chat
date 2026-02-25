import time
from unittest.mock import patch, MagicMock


def test_refresh_blocked_terms_updates_when_interval_elapsed():
    """refresh_blocked_terms_if_needed fetches new terms after interval."""
    from twitch_bot import TwitchBot

    bot = TwitchBot(
        bot_user_id="123",
        oauth_token="token",
        client_id="client",
        channel_user_id="456",
    )
    bot.blocked_terms = ["old_term"]
    bot._last_blocked_terms_refresh = time.time() - 1900  # 31+ minutes ago
    bot._blocked_terms_refresh_interval = 1800  # 30 minutes

    with patch.object(bot, "fetch_blocked_terms", return_value=["new_term"]) as mock_fetch:
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
    bot._last_blocked_terms_refresh = time.time()  # Just now
    bot._blocked_terms_refresh_interval = 1800

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
    bot._last_blocked_terms_refresh = 0
    bot._blocked_terms_refresh_interval = 0  # Disabled

    with patch.object(bot, "fetch_blocked_terms") as mock_fetch:
        bot.refresh_blocked_terms_if_needed()
        mock_fetch.assert_not_called()
