"""A ``Model`` loaded from only the rows a batch needs.

It is an ordinary :class:`Model`, so the op applier and the structural check run
on it unchanged, with one difference: a read it cannot answer from the loaded
rows raises :class:`NotLoaded` instead of answering from what happens to be in
memory. A silent answer would be a wrong accept or reject, so the guard sits on
every read the model offers:

- the entity dicts: ``in``, ``get`` and ``[]`` of an id that is neither loaded,
  known absent nor deleted here;
- the adjacency, containment-parent and referencer accessors of
  :class:`IndexSet`, each against the set of ids whose rows were loaded in full;
- enumeration (iterating the dicts, the roots), which can never be answered
  from a part of the model: :class:`WholeModelRead`.

Uniqueness groups are not kept; conformance is the engine's.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping, Sequence, Set
from dataclasses import dataclass
from typing import Any, overload

from ..metamodel.schema import Metamodel
from .element import Element
from .ids import IdGenerator
from .indexes import IndexSet
from .model import Model
from .relationship import Relationship


class NotLoaded(Exception):
    """A read of an id the partial model holds no answer for. Deliberately
    neither a ``KeyError`` nor a ``ValueError``: the op applier turns those into
    a 422, and this one is the caller's to load more rows for."""

    def __init__(self, ids: Iterable[str]) -> None:
        self.ids = frozenset(ids)
        super().__init__(f"not loaded: {sorted(self.ids)[:5]}")


class WholeModelRead(RuntimeError):
    """A whole-model read on a partial model: a bug in the caller, not a call
    for more rows."""

    def __init__(self, what: str) -> None:
        super().__init__(f"{what} is a whole-model read, which a partial model refuses")


@dataclass(frozen=True)
class PartialRows:
    """What a loader found, as decoded rows.

    A row is ``{"id", "type_name", "properties", "rev"}``; a relationship row
    also has ``"source_id"`` and ``"target_id"``.
    """

    #: in sequence order
    elements: Sequence[Mapping[str, Any]]
    #: in sequence order; both endpoints of each are in ``elements``
    relationships: Sequence[Mapping[str, Any]]
    #: queried in both tables, found in neither
    absent: frozenset[str]
    #: elements whose every incident relationship is loaded
    edges_complete: frozenset[str]
    #: elements whose every incoming containment relationship is loaded
    parents_complete: frozenset[str]
    #: ids whose every referencer is loaded
    referencers_complete: frozenset[str]


class _Known:
    """What the partial model knows it knows; shared by its dicts and indexes."""

    __slots__ = (
        "absent",
        "created",
        "edges",
        "loaded",
        "looked_for",
        "parents",
        "referencers",
        "unreferenced",
    )

    def __init__(self, rows: PartialRows, loaded: frozenset[str]) -> None:
        #: ids with no entity: the loader's, and every id deleted here. An absent
        #: id has no incident relationship (an endpoint always exists), so it
        #: has no edges or parents; its referencers are known only if loaded.
        self.absent = set(rows.absent)
        #: the ids the loader looked for and did not find
        self.looked_for = rows.absent
        self.edges = rows.edges_complete
        self.parents = rows.parents_complete | rows.edges_complete
        self.referencers = rows.referencers_complete
        #: the loaded elements
        self.loaded = loaded
        #: elements created here under an id that was not loaded: no edge or
        #: parent of theirs is missing from the model
        self.created: set[str] = set()
        #: created here and no referencer of theirs can exist outside the
        #: model: the id was never the loader's to look for (a fresh id). An id
        #: the loader looked for and did not find may still be the target of a
        #: dangling reference in the database, so creating it settles nothing.
        self.unreferenced: set[str] = set()


class _Entities[V](dict[str, V]):
    """An entity dict that answers only for what it can vouch for. A key that
    is present answers as usual; a missing key is absent when the loader found
    neither entity, when the other table holds it, or when it was deleted here;
    any other missing key is ``NotLoaded``. Writes stay as ``dict``'s: the
    ``Model`` mutation boundary keeps the indexes."""

    _known: _Known
    _other: _Entities[Any]

    def __init__(self, known: _Known) -> None:
        super().__init__()
        self._known = known

    def _check_absent(self, key: str) -> None:
        """Return when the model can vouch that ``key`` has no entity here."""
        if key not in self._known.absent and not dict.__contains__(self._other, key):
            raise NotLoaded((key,))

    def __contains__(self, key: object) -> bool:
        if dict.__contains__(self, key):
            return True
        self._check_absent(key)  # type: ignore[arg-type]
        return False

    @overload
    def get(self, key: str, default: None = None, /) -> V | None: ...
    @overload
    def get[D](self, key: str, default: D, /) -> V | D: ...
    def get[D](  # pyright: ignore[reportIncompatibleMethodOverride]
        self, key: str, default: D | None = None, /
    ) -> V | D | None:
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        self._check_absent(key)
        return default

    def __getitem__(self, key: str) -> V:
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        self._check_absent(key)
        raise KeyError(key)

    def __delitem__(self, key: str) -> None:
        dict.__delitem__(self, key)
        self._known.absent.add(key)

    @overload
    def pop(self, key: str, /) -> V: ...
    @overload
    def pop[D](self, key: str, default: D, /) -> V | D: ...
    def pop[D](  # pyright: ignore[reportIncompatibleMethodOverride]
        self, key: str, *default: D
    ) -> V | D:
        present = dict.__contains__(self, key)
        value = dict.pop(self, key, *default)
        if present:
            self._known.absent.add(key)
        return value

    def __len__(self) -> int:
        raise WholeModelRead("counting the entities")

    def __iter__(self) -> Iterator[str]:
        raise WholeModelRead("iterating the entities")

    def __reversed__(self) -> Iterator[str]:
        raise WholeModelRead("iterating the entities")

    def setdefault(self, *args: Any, **kwargs: Any) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        raise TypeError("a partial model's entities are written by the Model only")

    def popitem(self) -> tuple[str, V]:
        raise TypeError("a partial model's entities are removed by the Model only")

    def keys(self):  # type: ignore[override]
        raise WholeModelRead("listing the entity ids")

    def values(self):  # type: ignore[override]
        raise WholeModelRead("listing the entities")

    def items(self):  # type: ignore[override]
        raise WholeModelRead("listing the entities")


class PartialIndexSet(IndexSet):
    """An :class:`IndexSet` whose accessors answer only for ids whose rows were
    loaded in full (or created here). Uniqueness groups are not kept."""

    def __init__(self, model: Model, known: _Known) -> None:
        super().__init__(model)
        self._known = known

    def _need(self, element_id: str, complete: Set[str]) -> None:
        known = self._known
        if (
            element_id not in complete
            and element_id not in known.absent
            and element_id not in known.created
        ):
            raise NotLoaded((element_id,))

    # -- accessors ----------------------------------------------------------

    def outgoing_ids(self, element_id: str) -> Set[str]:
        self._need(element_id, self._known.edges)
        return super().outgoing_ids(element_id)

    def incoming_ids(self, element_id: str) -> Set[str]:
        self._need(element_id, self._known.edges)
        return super().incoming_ids(element_id)

    def count_out(self, element_id: str, rel_type_name: str) -> int:
        self._need(element_id, self._known.edges)
        return super().count_out(element_id, rel_type_name)

    def count_in(self, element_id: str, rel_type_name: str) -> int:
        self._need(element_id, self._known.edges)
        return super().count_in(element_id, rel_type_name)

    def parents_of(self, element_id: str) -> Sequence[str]:
        self._need(element_id, self._known.parents)
        return super().parents_of(element_id)

    def first_parent(self, element_id: str) -> str | None:
        self._need(element_id, self._known.parents)
        return super().first_parent(element_id)

    def referencers_of(self, element_id: str) -> Set[str]:
        known = self._known
        if element_id not in known.referencers and element_id not in known.unreferenced:
            raise NotLoaded((element_id,))
        return super().referencers_of(element_id)

    def contained_ids(self) -> Iterable[str]:
        raise WholeModelRead("listing the contained elements")

    def roots_count(self) -> int:
        raise WholeModelRead("counting the roots")

    def roots_page(self, offset: int, limit: int) -> list[str]:
        raise WholeModelRead("paging the roots")

    def iter_roots(self) -> Iterator[str]:
        raise WholeModelRead("iterating the roots")

    # -- hooks --------------------------------------------------------------

    def on_element_created(self, element: Element, order: int | None = None) -> None:
        super().on_element_created(element, order)
        known = self._known
        if element.id not in known.loaded:
            known.created.add(element.id)
            if element.id not in known.looked_for:
                known.unreferenced.add(element.id)

    # -- no uniqueness groups -----------------------------------------------

    def _add_to_group(self, element: Element) -> None:
        pass

    def _remove_from_group(self, element_id: str) -> None:
        pass

    def _rekey(self, element: Element) -> None:
        pass

    def _rekey_if_present(self, element_id: str) -> None:
        pass

    def _rekey_key_rel_endpoints(self, rel: Relationship) -> None:
        pass


def build_partial_model(
    metamodel: Metamodel,
    rows: PartialRows,
    *,
    id_generator: IdGenerator | None = None,
) -> Model:
    """A ``Model`` holding ``rows``, guarded as the module docstring says.

    Raises ``ValueError`` for rows that break the contract the guard relies on
    (a duplicate id, a relationship whose endpoint is not loaded, an id both
    loaded and absent, a completeness claim about an element that is not
    loaded)."""
    element_ids = {row["id"] for row in rows.elements}
    if len(element_ids) != len(rows.elements):
        raise ValueError("duplicate element id in the rows")
    relationship_ids = {row["id"] for row in rows.relationships}
    if len(relationship_ids) != len(rows.relationships):
        raise ValueError("duplicate relationship id in the rows")
    if element_ids & relationship_ids:
        raise ValueError("duplicate id: an element and a relationship share it")
    if rows.absent & (element_ids | relationship_ids):
        raise ValueError("an id is both absent and loaded")
    for row in rows.relationships:
        for end in ("source_id", "target_id"):
            if row[end] not in element_ids:
                raise ValueError(
                    f"relationship {row['id']!r} has an endpoint that is not "
                    f"loaded: {row[end]!r}"
                )
    if not rows.edges_complete <= element_ids:
        raise ValueError("edges_complete names an element that is not loaded")
    if not rows.parents_complete <= element_ids:
        raise ValueError("parents_complete names an element that is not loaded")

    known = _Known(rows, frozenset(element_ids))
    model = Model(metamodel, id_generator)
    elements = _Entities[Element](known)
    relationships = _Entities[Relationship](known)
    elements._other = relationships
    relationships._other = elements
    model.elements = elements
    model.relationships = relationships
    for row in rows.elements:
        elements[row["id"]] = Element(
            id=row["id"],
            type_name=row["type_name"],
            properties=dict(row["properties"]),
            rev=row["rev"],
        )
    for row in rows.relationships:
        relationships[row["id"]] = Relationship(
            id=row["id"],
            type_name=row["type_name"],
            source_id=row["source_id"],
            target_id=row["target_id"],
            properties=dict(row["properties"]),
            rev=row["rev"],
        )
    model.indexes = PartialIndexSet(model, known)
    model.indexes.rebuild()
    return model
