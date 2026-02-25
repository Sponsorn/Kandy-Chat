import time
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
