from text_filters import filter_cyrillic


def test_leaves_messages_without_cyrillic_alone():
    assert filter_cyrillic("Hi kàndy, livets problem kräver kalla lösningar") == (
        "Hi kàndy, livets problem kräver kalla lösningar",
        None,
    )
    assert filter_cyrillic("") == ("", None)


def test_drops_mostly_cyrillic_messages():
    assert filter_cyrillic("Ты красотка Kandy")[0] is None
    assert filter_cyrillic("Kandy а ты потанцевать можешь kandy 🤩 😍")[0] is None
    text, reason = filter_cyrillic("Танцевать не будешь kandy 😍")
    assert text is None
    assert reason == "mostly Cyrillic"


def test_strips_stray_cyrillic_from_latin_messages():
    # "к" and "а" below are Cyrillic look-alikes
    assert filter_cyrillic("hello кandy") == ("hello andy", None)
    assert filter_cyrillic("Kandy you look great а") == ("Kandy you look great", None)


def test_shortcodes_do_not_count_as_latin():
    assert filter_cyrillic("привет :heart: :heart:")[0] is None


def test_drops_when_nothing_meaningful_is_left():
    text, reason = filter_cyrillic("😍 😍 hi я я я я 😍")
    assert text is None
    assert reason == "mostly Cyrillic"
    text, reason = filter_cyrillic("я 😍 :heart:")
    assert text is None
