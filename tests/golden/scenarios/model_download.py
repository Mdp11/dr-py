"""The model file as ``GET /model/download`` streams it: committed state in
state order, each entity dumped as the server dumps it.

Over ``ops_batches``' metamodel, the first batch writes values whose text is
easy to get wrong: ``1.0``, ``1e-07``, ``-0.0``, ``1e16``, ``2**64``, astral
and control characters, a lone U+2028, an empty properties map, and nested
lists and dicts, which no datatype admits, in the string ``extra``. The file
is then downloaded after an update (the element keeps its place), after a
delete and re-create under the same id (the element goes last), after a
relationship delete and a rewire, with no relationships left, and with
nothing left; a second run downloads a model nothing ever touched. The second
through fourth downloads are repeated with ops staged that a walk over the
working model would show: an update, a delete that cascades, a create, a
delete and re-create under a committed id, and a relationship create. A
staged download is the committed file all the same."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, download_step, run_steps
from .ops_batches import _METAMODEL


def _el(temp_id: str, type_name: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": type_name,
        **extra,
    }


def _rel(
    temp_id: str, type_name: str, source: str, target: str, **extra: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        **extra,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _delete_rel(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


#: id-1…id-6 the elements, id-7…id-10 the relationships; id-2 owns id-5
_FIRST = [
    _el(
        "tmp_c1",
        "City",
        properties={
            "name": "héllo ✓ 𝄞",
            "population": 2**64,
            "area": 1.0,
            "extra": {"outer": {"inner": [1, -0.0, None]}, "empty": {}, "list": []},
        },
    ),
    _el(
        "tmp_c2",
        "City",
        properties={"name": "\x7f", "area": 1e-07, "population": 7},
    ),
    _el(
        "tmp_c3",
        "City",
        properties={
            "name": "\u2028",
            "area": 1e16,
            "extra": [[1, [2.5, "x"]], {"k": True}],
        },
    ),
    _el("tmp_d1", "District", properties={}),
    _el("tmp_p1", "Person", properties={"name": "p1"}),
    _el("tmp_p2", "Person", properties={"name": "p2"}),
    _rel("tmp_o1", "Owns", "tmp_c1", "tmp_d1"),
    _rel("tmp_k1", "Knows", "tmp_p1", "tmp_p2", properties={"since": 1990}),
    _rel("tmp_k2", "Knows", "tmp_p2", "tmp_p1", properties={"since": 2**64}),
    _rel("tmp_o2", "Owns", "tmp_c2", "tmp_p1"),
]

#: id-2's name dropped, its area replaced in place, a key added at its end
_UPDATE = [_update("id-2", name=None, area=-0.0, extra="added")]

#: id-3 goes, and comes back under its own id at the end of the state order
_RECREATE = [
    _delete("id-3"),
    _el("tmp_c3", "City", id="id-3", properties={"name": "again"}),
]

#: id-9 goes; id-8 is rewired under its own id to new ends
_REWIRE = [
    _delete_rel("id-9"),
    _delete_rel("id-8"),
    _rel("tmp_k", "Knows", "id-6", "id-5", id="id-8", properties={"since": 2001}),
]


def _stages() -> list[list[dict[str, Any]]]:
    """For each of the second through fourth downloads, ops over what is
    committed there: an update, a delete, a create, a delete and re-create
    under a committed id, and a relationship create. Deleting id-2 takes
    id-5, which it owns, and with it the ``Knows`` edges."""
    return [
        # after _UPDATE
        [
            _update("id-1", name="staged", population=None),
            _delete("id-2"),
            _el("tmp_s", "City", properties={"name": "new"}),
            _delete("id-6"),
            _el("tmp_r", "Person", id="id-6", properties={"name": "back"}),
            _rel("tmp_n", "Owns", "id-1", "tmp_r"),
        ],
        # after _RECREATE
        [
            _update("id-4", name="d"),
            _delete("id-1"),
            _el("tmp_s", "District"),
            _delete("id-3"),
            _el("tmp_r", "City", id="id-3", properties={"name": "third"}),
            _rel("tmp_n", "Knows", "id-6", "id-5"),
        ],
        # after _REWIRE
        [
            _update("id-6", name="q"),
            _delete("id-3"),
            _el("tmp_s", "Person", properties={"name": "s"}),
            _delete("id-5"),
            _el("tmp_r", "Person", id="id-5", properties={"name": "p1"}),
            _rel("tmp_n", "Knows", "tmp_r", "id-6"),
            _rel("tmp_m", "Owns", "id-1", "tmp_s"),
        ],
    ]


def _main() -> dict[str, Any]:
    staged = iter(_stages())
    steps: list[dict[str, Any]] = [batch(_FIRST), {"do": "seed"}, download_step()]
    for ops in (_UPDATE, _RECREATE, _REWIRE):
        steps += [batch(ops), download_step(), download_step(next(staged))]
    steps += [
        batch([_delete_rel("id-7"), _delete_rel("id-8"), _delete_rel("id-10")]),
        download_step(),
        batch([_delete(f"id-{n}") for n in range(1, 7)]),
        download_step(),
    ]
    return run_steps(Metamodel.model_validate(_METAMODEL), steps)


def _checked(run: dict[str, Any]) -> list[str]:
    """The run's downloads, each staged one held to its unstaged neighbour."""
    texts: list[str] = []
    previous: dict[str, Any] | None = None
    for step in run["steps"]:
        assert step["error"] is None, step
        if step["do"] != "download":
            previous = None
            continue
        if "stage" in step:
            assert previous is not None and step["result"] == previous["result"], step
        else:
            texts.append(step["result"])
        previous = step
    return texts


@scenario("model_download")
def model_download() -> Any:
    main = _main()
    texts = _checked(main)
    assert len(texts) == 6, len(texts)
    assert len(set(texts)) == 6, "every download changes the file"
    assert '"relationships": []' in texts[4] and '"elements": []' in texts[5]
    fresh = run_steps(Metamodel.model_validate(_METAMODEL), [download_step()])
    assert _checked(fresh) == [texts[5]]
    return {"runs": [main, fresh]}
