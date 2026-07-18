"""Facade doc extraction: the tripwire and the doc-model contract."""

import dataclasses
import textwrap

import pytest

from data_rover.core.script import docs
from data_rover.core.script.docs import FacadeDocEntry, get_facade_docs


def _by_name() -> dict[str, FacadeDocEntry]:
    return {e.name: e for e in get_facade_docs()}


def test_every_public_member_present_and_documented():
    entries = _by_name()
    expected = {
        "dr.element", "dr.elements", "dr.types", "dr.type",
        "dr.create", "dr.connect", "dr.disconnect",
        "dr.BridgeError", "dr.ReadOnlyError", "dr.NotFoundError",
        "Element.id", "Element.type", "Element.name",
        "Element.get", "Element.props", "Element.out", "Element.in_",
        "Element.parent", "Element.children", "Element.set", "Element.delete",
    }
    assert set(entries) == expected
    for e in entries.values():
        assert e.doc.strip(), f"{e.name} has an empty doc"


def test_signatures_render_public_names_and_defaults():
    entries = _by_name()
    assert entries["dr.create"].signature == "dr.create(type_name, properties=None) -> str (temp id)"
    assert entries["dr.elements"].signature == "dr.elements(type=None) -> iterator of Element"
    assert entries["Element.set"].signature == "Element.set(key, value)"
    assert entries["Element.get"].signature == "Element.get(key, default=None) -> value or default"
    assert entries["Element.id"].signature == "Element.id -> str"
    assert entries["dr.NotFoundError"].signature == "dr.NotFoundError"


def test_kinds_and_example_split():
    entries = _by_name()
    assert entries["dr.create"].kind == "function"
    assert entries["Element.set"].kind == "method"
    assert entries["Element.id"].kind == "property"
    assert entries["dr.BridgeError"].kind == "exception"
    assert entries["dr.create"].example is not None
    assert 'dr.create("Building"' in entries["dr.create"].example
    assert "Example:" not in entries["dr.create"].doc
    assert entries["Element.delete"].example is None


def test_entries_are_frozen_and_cached():
    assert dataclasses.is_dataclass(FacadeDocEntry)
    with pytest.raises(dataclasses.FrozenInstanceError):
        dataclasses.replace(get_facade_docs()[0]).__setattr__("name", "x")  # type: ignore[misc]
    assert get_facade_docs() is get_facade_docs()


def test_undocumented_member_trips_the_tripwire(monkeypatch):
    """A public facade member with no docstring at all is a hard failure —
    the drift tripwire this module exists for."""
    doctored = textwrap.dedent(
        """
        def _bad(id):
            pass

        class _Dr:
            bad = staticmethod(_bad)

        class Element:
            pass
        """
    )
    monkeypatch.setattr(docs, "FACADE_SOURCE", doctored)
    get_facade_docs.cache_clear()
    try:
        with pytest.raises(ValueError, match=r"dr\.bad"):
            get_facade_docs()
    finally:
        get_facade_docs.cache_clear()


def test_example_without_summary_trips_the_tripwire(monkeypatch):
    """An `Example:` block with nothing before it also has no summary, so it
    trips the same tripwire as a missing docstring."""
    doctored = textwrap.dedent(
        '''
        def _bad(id):
            """Example:
                dr.bad()
            """

        class _Dr:
            bad = staticmethod(_bad)

        class Element:
            pass
        '''
    )
    monkeypatch.setattr(docs, "FACADE_SOURCE", doctored)
    get_facade_docs.cache_clear()
    try:
        with pytest.raises(ValueError, match=r"dr\.bad"):
            get_facade_docs()
    finally:
        get_facade_docs.cache_clear()
