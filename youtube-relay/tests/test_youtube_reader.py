import time
import pytest
from unittest.mock import patch, MagicMock


def test_reader_puts_messages_on_queue():
    """YouTubeChatReader pushes parsed messages onto its queue."""
    from youtube_reader import YouTubeChatReader

    fake_messages = [
        {"author": {"name": "Alice"}, "message": "Hello world", "message_type": "text_message"},
        {"author": {"name": "Bob"}, "message": "Hi there", "message_type": "text_message"},
    ]

    with patch("youtube_reader.ChatDownloader") as MockCD:
        mock_chat = MagicMock()
        mock_chat.__iter__ = MagicMock(return_value=iter(fake_messages))
        MockCD.return_value.get_chat.return_value = mock_chat

        reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
        reader.start()
        time.sleep(0.5)

        results = []
        while not reader.queue.empty():
            results.append(reader.queue.get_nowait())

        reader.stop()

        assert len(results) == 2
        assert results[0] == {"author": "Alice", "message": "Hello world"}
        assert results[1] == {"author": "Bob", "message": "Hi there"}


def test_reader_skips_non_text_messages():
    """YouTubeChatReader ignores non-text message types."""
    from youtube_reader import YouTubeChatReader

    fake_messages = [
        {"author": {"name": "Alice"}, "message": "Hello", "message_type": "text_message"},
        {"author": {"name": "System"}, "message": "joined", "message_type": "membership_item"},
        {"author": {"name": "Bob"}, "message": "World", "message_type": "text_message"},
    ]

    with patch("youtube_reader.ChatDownloader") as MockCD:
        mock_chat = MagicMock()
        mock_chat.__iter__ = MagicMock(return_value=iter(fake_messages))
        MockCD.return_value.get_chat.return_value = mock_chat

        reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
        reader.start()
        time.sleep(0.5)

        results = []
        while not reader.queue.empty():
            results.append(reader.queue.get_nowait())

        reader.stop()

        assert len(results) == 2
        assert results[0]["author"] == "Alice"
        assert results[1]["author"] == "Bob"


def test_reader_handles_missing_author_name():
    """YouTubeChatReader uses 'Unknown' when author name is missing."""
    from youtube_reader import YouTubeChatReader

    fake_messages = [
        {"author": {}, "message": "No name", "message_type": "text_message"},
    ]

    with patch("youtube_reader.ChatDownloader") as MockCD:
        mock_chat = MagicMock()
        mock_chat.__iter__ = MagicMock(return_value=iter(fake_messages))
        MockCD.return_value.get_chat.return_value = mock_chat

        reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
        reader.start()
        time.sleep(0.5)

        msg = reader.queue.get_nowait()
        reader.stop()

        assert msg["author"] == "Unknown"


def test_reader_stop_sets_running_false():
    """Calling stop() sets running to False."""
    from youtube_reader import YouTubeChatReader

    with patch("youtube_reader.ChatDownloader"):
        reader = YouTubeChatReader("https://www.youtube.com/@TestChannel")
        reader.running = True
        reader.stop()
        assert reader.running is False
