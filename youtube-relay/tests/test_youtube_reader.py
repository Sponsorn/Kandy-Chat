import time
import threading
import pytest
from unittest.mock import patch, MagicMock


def _make_innertube_response(messages, continuation="next_token"):
    """Build a fake innertube API response with chat messages."""
    actions = []
    for author, text in messages:
        actions.append({
            "addChatItemAction": {
                "item": {
                    "liveChatTextMessageRenderer": {
                        "authorName": {"simpleText": author},
                        "message": {"runs": [{"text": text}]},
                    }
                }
            }
        })

    cont_data = {}
    if continuation:
        cont_data = {
            "timedContinuationData": {
                "continuation": continuation,
                "timeoutMs": 1000,
            }
        }

    return {
        "continuationContents": {
            "liveChatContinuation": {
                "actions": actions,
                "continuations": [cont_data] if cont_data else [],
            }
        }
    }


def test_reader_puts_messages_on_queue():
    """YouTubeChatReader pushes parsed messages onto its queue."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    poll_response = _make_innertube_response(
        [("Alice", "Hello world"), ("Bob", "Hi there")],
        continuation=None,  # End after one poll
    )

    with patch.object(reader, "_find_live_video_id", return_value="test123"), \
         patch.object(reader, "_get_initial_chat_data", return_value=("init_token", "key")), \
         patch.object(reader, "_poll_chat", return_value=(
             [{"author": "Alice", "message": "Hello world"},
              {"author": "Bob", "message": "Hi there"}],
             None, 1000,
         )):
        reader.start()
        time.sleep(0.5)

        results = []
        while not reader.queue.empty():
            results.append(reader.queue.get_nowait())

        reader.stop()

        assert len(results) == 2
        assert results[0] == {"author": "Alice", "message": "Hello world"}
        assert results[1] == {"author": "Bob", "message": "Hi there"}


def test_poll_chat_parses_text_messages():
    """_poll_chat correctly parses text messages from innertube response."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    response_data = _make_innertube_response(
        [("Alice", "Hello"), ("Bob", "World")],
        continuation="next",
    )

    mock_resp = MagicMock()
    mock_resp.json.return_value = response_data
    mock_resp.raise_for_status = MagicMock()

    with patch("youtube_reader.requests.post", return_value=mock_resp):
        messages, cont, timeout = reader._poll_chat("token", "key")

    assert len(messages) == 2
    assert messages[0] == {"author": "Alice", "message": "Hello"}
    assert messages[1] == {"author": "Bob", "message": "World"}
    assert cont == "next"


def test_poll_chat_skips_non_text_messages():
    """_poll_chat ignores membership items and other non-text messages."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    response_data = {
        "continuationContents": {
            "liveChatContinuation": {
                "actions": [
                    {
                        "addChatItemAction": {
                            "item": {
                                "liveChatTextMessageRenderer": {
                                    "authorName": {"simpleText": "Alice"},
                                    "message": {"runs": [{"text": "Hello"}]},
                                }
                            }
                        }
                    },
                    {
                        "addChatItemAction": {
                            "item": {
                                "liveChatMembershipItemRenderer": {
                                    "authorName": {"simpleText": "System"},
                                }
                            }
                        }
                    },
                ],
                "continuations": [{"timedContinuationData": {"continuation": "c", "timeoutMs": 1000}}],
            }
        }
    }

    mock_resp = MagicMock()
    mock_resp.json.return_value = response_data
    mock_resp.raise_for_status = MagicMock()

    with patch("youtube_reader.requests.post", return_value=mock_resp):
        messages, _, _ = reader._poll_chat("token", "key")

    assert len(messages) == 1
    assert messages[0]["author"] == "Alice"


def test_poll_chat_handles_emoji_runs():
    """_poll_chat renders emoji shortcuts in message text."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    response_data = {
        "continuationContents": {
            "liveChatContinuation": {
                "actions": [{
                    "addChatItemAction": {
                        "item": {
                            "liveChatTextMessageRenderer": {
                                "authorName": {"simpleText": "Alice"},
                                "message": {"runs": [
                                    {"text": "hi "},
                                    {"emoji": {"shortcuts": [":heart:"]}},
                                ]},
                            }
                        }
                    }
                }],
                "continuations": [{"timedContinuationData": {"continuation": "c", "timeoutMs": 1000}}],
            }
        }
    }

    mock_resp = MagicMock()
    mock_resp.json.return_value = response_data
    mock_resp.raise_for_status = MagicMock()

    with patch("youtube_reader.requests.post", return_value=mock_resp):
        messages, _, _ = reader._poll_chat("token", "key")

    assert messages[0]["message"] == "hi :heart:"


def test_reader_stop_sets_running_false():
    """Calling stop() sets running to False."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
    reader.running = True
    reader.stop()
    assert reader.running is False


# --- resilience tests ---


def test_poll_chat_retries_same_continuation_on_transient_error():
    """A transient poll failure retries with the same token instead of rediscovering."""
    from youtube_reader import YouTubeChatReader, TransientPollError

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    calls = []

    def fake_poll(continuation, api_key):
        calls.append(continuation)
        if len(calls) == 1:
            raise TransientPollError("HTTP 503")
        if len(calls) == 2:
            return [{"author": "A", "message": "after retry"}], "second", 1000
        return [], None, 1000

    with patch.object(reader, "_find_live_video_id", return_value="vid"), \
         patch.object(reader, "_get_initial_chat_data", return_value=("first", "key")), \
         patch.object(reader, "_poll_chat", side_effect=fake_poll), \
         patch.object(reader, "_wait", return_value=False):
        reader.start()
        time.sleep(0.5)
        reader.stop()

    # First call failed, second call reused the same token
    assert calls[0] == "first"
    assert calls[1] == "first"
    assert calls[2] == "second"
    assert reader.queue.get_nowait() == {"author": "A", "message": "after retry"}
    assert reader.stats["poll_retries"] == 1


def test_poll_chat_raises_transient_on_5xx_and_429():
    """5xx and 429 responses are transient, other HTTP errors are not."""
    from youtube_reader import YouTubeChatReader, TransientPollError

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    for status in (500, 503, 429):
        mock_resp = MagicMock()
        mock_resp.status_code = status
        with patch("youtube_reader.requests.post", return_value=mock_resp):
            with pytest.raises(TransientPollError):
                reader._poll_chat("token", "key")


def test_poll_chat_raises_transient_on_bad_json():
    from youtube_reader import YouTubeChatReader, TransientPollError

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.side_effect = ValueError("bad json")
    with patch("youtube_reader.requests.post", return_value=mock_resp):
        with pytest.raises(TransientPollError):
            reader._poll_chat("token", "key")


def test_poll_chat_accepts_reload_continuation():
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "continuationContents": {
            "liveChatContinuation": {
                "actions": [],
                "continuations": [{"reloadContinuationData": {"continuation": "reload-token"}}],
            }
        }
    }
    with patch("youtube_reader.requests.post", return_value=mock_resp):
        _, cont, _ = reader._poll_chat("token", "key")
    assert cont == "reload-token"


def test_poll_chat_drops_replayed_message_ids():
    """A message id seen before (e.g. after a reconnect) is not queued twice."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    def response(msg_id):
        return {
            "continuationContents": {
                "liveChatContinuation": {
                    "actions": [{
                        "addChatItemAction": {
                            "item": {
                                "liveChatTextMessageRenderer": {
                                    "id": msg_id,
                                    "authorName": {"simpleText": "Alice"},
                                    "message": {"runs": [{"text": "Hello"}]},
                                }
                            }
                        }
                    }],
                    "continuations": [{"timedContinuationData": {"continuation": "c", "timeoutMs": 1000}}],
                }
            }
        }

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.side_effect = [response("m1"), response("m1"), response("m2")]
    with patch("youtube_reader.requests.post", return_value=mock_resp):
        first, _, _ = reader._poll_chat("t", "k")
        second, _, _ = reader._poll_chat("t", "k")
        third, _, _ = reader._poll_chat("t", "k")

    assert len(first) == 1
    assert second == []
    assert len(third) == 1


def test_reconnect_reuses_last_video_id_before_ytdlp():
    """After a session ends, the reader reattaches to the known video without yt-dlp."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
    reader._last_video_id = "known"

    find = MagicMock(return_value="other")
    initial = MagicMock(return_value=("tok", "key"))

    with patch.object(reader, "_find_live_video_id", find), \
         patch.object(reader, "_get_initial_chat_data", initial):
        result = reader._connect()

    assert result == ("known", "tok", "key")
    find.assert_not_called()
    initial.assert_called_once_with("known")


def test_reconnect_falls_back_to_ytdlp_when_reattach_fails():
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
    reader._last_video_id = "ended"

    def initial(video_id):
        if video_id == "ended":
            raise Exception("No continuations found in live chat data")
        return ("tok", "key")

    with patch.object(reader, "_find_live_video_id", return_value="new"), \
         patch.object(reader, "_get_initial_chat_data", side_effect=initial):
        result = reader._connect()

    assert result == ("new", "tok", "key")
    assert reader._last_video_id == "new"


def test_restart_does_not_leave_old_thread_feeding_queue():
    """stop() then start() must not let the previous thread push messages."""
    from youtube_reader import YouTubeChatReader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")

    # First generation: a poll that blocks until we release it, then returns a message
    release = threading.Event()

    def slow_poll(continuation, api_key):
        release.wait(timeout=1)
        return [{"author": "old", "message": "stale"}], "next", 1000

    with patch.object(reader, "_find_live_video_id", return_value="vid"), \
         patch.object(reader, "_get_initial_chat_data", return_value=("tok", "key")), \
         patch.object(reader, "_poll_chat", side_effect=slow_poll):
        reader.start()
        time.sleep(0.2)
        first_thread = reader._thread
        reader.stop()

    # Second generation: a poll that never returns messages
    with patch.object(reader, "_find_live_video_id", return_value="vid"), \
         patch.object(reader, "_get_initial_chat_data", return_value=("tok", "key")), \
         patch.object(reader, "_poll_chat", return_value=([], "next", 1000)):
        reader.start()
        assert reader._thread is not first_thread
        release.set()  # old thread's poll returns now
        first_thread.join(timeout=5)
        time.sleep(0.2)
        reader.stop()

    assert reader.queue.empty()
    assert not first_thread.is_alive()


def test_no_live_stream_uses_flat_wait_not_backoff():
    """Without a live stream the reader waits a flat interval and keeps checking."""
    from youtube_reader import YouTubeChatReader
    import youtube_reader

    reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
    waits = []

    def fake_wait(stop_event, seconds):
        waits.append(seconds)
        return len(waits) >= 3  # stop after three waits

    with patch.object(reader, "_find_live_video_id", return_value=None), \
         patch.object(reader, "_wait", side_effect=fake_wait):
        reader._read_loop(1, threading.Event())

    assert waits == [youtube_reader._NO_STREAM_WAIT] * 3


# --- emoji rendering ---


def test_render_emoji_prefers_ascii_shortcode():
    from youtube_reader import _render_emoji_run

    assert _render_emoji_run({"emojiId": "❤️", "shortcuts": [":heart:"]}) == ":heart:"


def test_render_emoji_uses_unicode_when_no_ascii_shortcode():
    """Flags and similar have no ASCII shortcode; emit the emoji itself, not :label:."""
    from youtube_reader import _render_emoji_run

    flag = "\U0001F1E7\U0001F1F7"  # Brazil
    run = {
        "emojiId": flag,
        "shortcuts": [],
        "isCustomEmoji": False,
        "image": {"accessibility": {"accessibilityData": {"label": flag}}},
    }
    assert _render_emoji_run(run) == flag

    # Same when YouTube only offers a non-ASCII shortcut
    run["shortcuts"] = [f":{flag}:"]
    assert _render_emoji_run(run) == flag


def test_render_emoji_custom_without_shortcode_uses_label():
    from youtube_reader import _render_emoji_run

    run = {
        "emojiId": "UCabc/xyz",
        "isCustomEmoji": True,
        "image": {"accessibility": {"accessibilityData": {"label": "kandy hype"}}},
    }
    assert _render_emoji_run(run) == ":kandy_hype:"


def test_render_emoji_unicode_label_fallback_is_not_wrapped():
    from youtube_reader import _render_emoji_run

    run = {"image": {"accessibility": {"accessibilityData": {"label": "\U0001F600"}}}}
    assert _render_emoji_run(run) == "\U0001F600"
