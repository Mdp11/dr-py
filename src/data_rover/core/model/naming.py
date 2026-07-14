"""Display-name derivation shared by the API read routes and the IndexSet.

Kept in lock-step with the frontend's ``elementDisplayName``
(``frontend/src/lib/util/element-name.ts``) so a row's label is identical
whether it comes from the lite (server) or full (client) source. The roots
order index sorts by this value, so moving/changing it changes server-side
tree ordering — treat the semantics as frozen.
"""

from __future__ import annotations

from .element import Element


def _name_str(value: object) -> str | None:
    """A usable name out of a property value: the string itself, or — for a
    multiplicity-many ``name`` (a list, e.g. from a migrated legacy model) —
    the first non-empty string entry."""
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (list, tuple)):
        for v in value:
            if isinstance(v, str) and v:
                return v
    return None


def display_name(element: Element) -> str:
    """The case-insensitive non-empty ``name`` property, else the id.

    An exact lowercase ``name`` wins over other casings (``Name``/``NAME``).
    List values (multiplicity-many names) contribute their first non-empty
    string entry.
    """
    props = element.properties
    exact = _name_str(props.get("name"))
    if exact is not None:
        return exact
    for key, value in props.items():
        if key != "name" and key.lower() == "name":
            found = _name_str(value)
            if found is not None:
                return found
    return element.id
