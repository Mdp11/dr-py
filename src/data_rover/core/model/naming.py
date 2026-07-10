"""Display-name derivation shared by the API read routes and the IndexSet.

Kept in lock-step with the frontend's ``elementDisplayName``
(``frontend/src/lib/util/element-name.ts``) so a row's label is identical
whether it comes from the lite (server) or full (client) source. The roots
order index sorts by this value, so moving/changing it changes server-side
tree ordering — treat the semantics as frozen.
"""

from __future__ import annotations

from .element import Element


def display_name(element: Element) -> str:
    """The case-insensitive non-empty ``name`` property, else the id.

    An exact lowercase ``name`` wins over other casings (``Name``/``NAME``).
    """
    props = element.properties
    exact = props.get("name")
    if isinstance(exact, str) and exact:
        return exact
    for key, value in props.items():
        if key != "name" and key.lower() == "name" and isinstance(value, str) and value:
            return value
    return element.id
