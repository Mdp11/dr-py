"""A commit checked on a partial model answers exactly what the full model does.

For each seed a random model is installed and a random batch is committed
through the route. The same batch then runs on a full core ``Model`` built from
the same document (``commit_oracle.Oracle``). The two must agree on accept or
reject (with the same status and body), and on accept on everything the commit
leaves behind. The commit is then reverted, and the rows must again equal the
oracle's revert, whose entities hold the installed state.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import commit_load, content
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.core.model import model as model_mod
from data_rover.core.model.ids import SequentialIdGenerator

from .commit_oracle import (
    MM,
    Oracle,
    assert_commit_row,
    assert_rows,
    head_refs,
    model_ops,
    session,
)
from .conftest import AUTH_HEADERS, head, install, post_commit, seed_default_project

SEEDS = range(300)


@dataclass
class Facts:
    """What the generator knows of the installed model."""

    elements: list[str]
    parent: dict[str, list[str]]
    children: dict[str, list[str]]
    contains: list[str]
    links: list[str]
    ghosts: list[str]
    #: ids some property points at
    referenced: set[str]
    #: relationship id -> (source, target)
    ends: dict[str, tuple[str, str]]

    def descendants(self, eid: str) -> set[str]:
        out: set[str] = set()
        stack = [eid]
        while stack:
            for child in self.children.get(stack.pop(), []):
                if child not in out:
                    out.add(child)
                    stack.append(child)
        return out


def make_model(rng: random.Random, seed: int) -> tuple[str, Facts]:
    size = rng.randint(40, 120)
    ids = [f"e{i:03d}" for i in range(size)]
    ghosts = [f"ghost{i}" for i in range(rng.randint(0, 3))]
    parent: dict[str, list[str]] = {}
    children: dict[str, list[str]] = {}
    relationships: list[dict[str, Any]] = []
    contains: list[str] = []

    def contain(src: str, dst: str) -> None:
        rid = f"c{len(relationships):03d}"
        relationships.append(
            {
                "id": rid,
                "type_name": "Contains",
                "source_id": src,
                "target_id": dst,
                "properties": {},
                "rev": rng.randint(0, 3),
            }
        )
        contains.append(rid)
        parent.setdefault(dst, []).append(src)
        children.setdefault(src, []).append(dst)

    for i in range(1, size):
        if rng.random() < 0.8:
            # a mix of shallow and deep trees
            p = i - 1 if rng.random() < 0.3 else rng.randrange(i)
            contain(ids[p], ids[i])
    if seed % 11 == 0:  # a second parent already in the model
        contain(rng.choice(ids), rng.choice(ids[1:]))
    if seed % 17 == 5 and children:  # a containment cycle already in the model
        top = next(iter(children))
        bottom = rng.choice(sorted(_descendants(children, top)) or [top])
        contain(bottom, top)
    links: list[str] = []
    for _ in range(rng.randint(0, 80)):
        rid = f"l{len(relationships):03d}"
        props: dict[str, Any] = {}
        if rng.random() < 0.3:
            props["via"] = rng.choice(ids)
        relationships.append(
            {
                "id": rid,
                "type_name": "Link",
                "source_id": rng.choice(ids),
                "target_id": rng.choice(ids),
                "properties": props,
                "rev": rng.randint(0, 3),
            }
        )
        links.append(rid)
    elements = []
    for eid in ids:
        props = {}
        if rng.random() < 0.6:
            props["label"] = rng.choice(["a", "b", "c", "é中"])
        if rng.random() < 0.3:
            props["n"] = rng.choice([1, 2**60, -7])
        if rng.random() < 0.2:
            props["x"] = rng.choice([1.0, 0.5])
        if rng.random() < 0.3:
            props["ref"] = rng.choice(ids)
        if rng.random() < 0.2:
            props["refs"] = rng.sample(ids, rng.randint(1, 3))
        elements.append(
            {
                "id": eid,
                "type_name": "Node",
                "properties": props,
                "rev": rng.randint(0, 5),
            }
        )
    for ghost in ghosts:  # references to nothing
        holder = rng.choice(elements)["properties"]
        if rng.random() < 0.5:
            holder["ref"] = ghost
        else:
            holder["refs"] = [*holder.get("refs", []), ghost]
    referenced: set[str] = set()
    for entity in (*elements, *relationships):
        for name in ("ref", "refs", "via"):
            value = entity["properties"].get(name)
            referenced.update(value if isinstance(value, list) else [value])
    text = json.dumps({"elements": elements, "relationships": relationships})
    ends = {r["id"]: (r["source_id"], r["target_id"]) for r in relationships}
    return text, Facts(ids, parent, children, contains, links, ghosts, referenced, ends)


def _descendants(children: dict[str, list[str]], eid: str) -> set[str]:
    out: set[str] = set()
    stack = [eid]
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in out:
                out.add(child)
                stack.append(child)
    return out


class Batch:
    """A random batch over a model's ids and the temp ids it makes."""

    def __init__(self, rng: random.Random, facts: Facts, tag: str) -> None:
        self.rng = rng
        self.facts = facts
        self.tag = tag
        #: a clean batch names only ids that exist (or that it creates)
        self.clean = rng.random() < 0.7
        self.ops: list[dict[str, Any]] = []
        self.live = list(facts.elements)
        self.tmps: list[str] = []
        self.tmp_rels: list[str] = []
        self.tmp_links: list[str] = []
        self.dead: list[str] = []
        self.n = 0

    def fresh(self, prefix: str) -> str:
        self.n += 1
        return f"{prefix}{self.tag}_{self.n}"

    def any_element(self) -> str:
        pool = [*self.live, *self.tmps]
        if not self.clean:
            if self.dead and self.rng.random() < 0.05:
                return self.rng.choice(self.dead)
            if self.facts.ghosts and self.rng.random() < 0.03:
                return self.rng.choice(self.facts.ghosts)
            if self.rng.random() < 0.02:
                return "nope"
        return self.rng.choice(pool) if pool else "nope"

    def props(self) -> dict[str, Any]:
        rng = self.rng
        out: dict[str, Any] = {}
        if rng.random() < 0.5:
            out["label"] = rng.choice(["a", "z", "é"])
        if rng.random() < 0.3:
            out["n"] = rng.choice([1, 5, 2**60])
        if rng.random() < 0.4:
            out["ref"] = self.any_element()
        if rng.random() < 0.3:
            out["refs"] = [self.any_element() for _ in range(rng.randint(1, 3))]
        return out

    def pick_by_shape(self) -> str:
        """A root, a leaf or a middle element; in a clean batch one nothing
        points into when there is such a one."""
        f = self.facts
        shape = self.rng.choice(["root", "leaf", "middle"])
        if shape == "root":
            pool = [e for e in self.live if e not in f.parent]
        elif shape == "leaf":
            pool = [e for e in self.live if e not in f.children]
        else:
            pool = [e for e in self.live if e in f.parent and e in f.children]
        pool = pool or self.live
        if self.clean:
            quiet = [e for e in pool if not ({e, *f.descendants(e)} & f.referenced)]
            pool = quiet or pool
        return self.rng.choice(pool)

    def add(self, op: dict[str, Any]) -> None:
        self.ops.append(op)

    def create_element(self, hint: str | None = None) -> str:
        tmp = self.fresh("tmp_e")
        op: dict[str, Any] = {
            "kind": "create_element",
            "temp_id": tmp,
            "type_name": "Node",
            "properties": self.props(),
        }
        if hint is not None:
            op["id"] = hint
        self.add(op)
        self.tmps.append(tmp)
        return tmp

    def create_rel(
        self, typ: str, source: str, target: str, hint: str | None = None
    ) -> str:
        tmp = self.fresh("tmp_r")
        op: dict[str, Any] = {
            "kind": "create_relationship",
            "temp_id": tmp,
            "type_name": typ,
            "source_id": source,
            "target_id": target,
            "properties": {"via": self.any_element()}
            if typ == "Link" and self.rng.random() < 0.4
            else {},
        }
        if hint is not None:
            op["id"] = hint
        self.add(op)
        self.tmp_rels.append(tmp)
        if typ == "Link":
            self.tmp_links.append(tmp)
        return tmp

    def any_rel(self) -> str:
        pool = [*self.facts.contains, *self.facts.links, *self.tmp_rels]
        if not self.clean and self.rng.random() < 0.03:
            return "nope-rel"
        return self.rng.choice(pool) if pool else "nope-rel"

    def build(self) -> list[dict[str, Any]]:
        rng = self.rng
        f = self.facts
        kinds = [
            ("create", 3),
            ("update", 3),
            ("delete", 2),
            ("contain", 3),
            ("link", 1),
            ("disconnect", 2),
            ("recreate_element", 1),
            ("recreate_rel", 1),
            ("attach_then_delete", 1),
            ("update_rel", 1),
            ("cross_table_hint", 1),
        ]
        names = [k for k, w in kinds for _ in range(w)]
        for _ in range(rng.randint(1, 12)):
            kind = rng.choice(names)
            if kind == "create":
                roll = rng.random()
                hint = None
                if roll < 0.2:
                    hint = self.fresh("h")
                elif roll < 0.25 and not self.clean:
                    hint = rng.choice(f.elements)  # taken
                elif roll < 0.3 and self.dead:
                    hint = rng.choice(self.dead)  # free again
                elif roll < 0.4 and f.ghosts:
                    hint = rng.choice(f.ghosts)  # settles a dangling reference
                self.create_element(hint)
            elif kind == "update":
                patch = self.props()
                if rng.random() < 0.3:
                    patch["ref"] = None
                if rng.random() < 0.03 and not self.clean:
                    patch["bogus"] = 1
                self.add(
                    {
                        "kind": "update_element",
                        "id": self.any_element(),
                        "properties_patch": patch or {"label": "q"},
                    }
                )
            elif kind == "delete":
                if not self.clean and rng.random() < 0.1:
                    # an id that is no element
                    self.add({"kind": "delete_element", "id": self.any_rel()})
                elif rng.random() < 0.15 and self.tmps:
                    self.add({"kind": "delete_element", "id": rng.choice(self.tmps)})
                else:
                    eid = self.pick_by_shape()
                    self.add({"kind": "delete_element", "id": eid})
                    # the cascade takes the subtree with it
                    gone = {eid, *f.descendants(eid)}
                    self.dead.extend(sorted(gone & set(self.live)))
                    self.live = [e for e in self.live if e not in gone]
            elif kind == "contain":
                mode = rng.choice(["attach", "cycle", "second_parent", "tmp"])
                src, dst = self.any_element(), self.any_element()
                if self.clean:
                    roots = [e for e in self.live if e not in f.parent]
                    if roots:
                        dst = rng.choice(roots)
                        below = {dst, *f.descendants(dst)}
                        src = rng.choice(
                            [e for e in self.live if e not in below] or [src]
                        )
                elif mode == "cycle" and self.live:
                    dst = rng.choice(self.live)
                    below = sorted(f.descendants(dst) & set(self.live))
                    src = rng.choice(below) if below else dst
                elif mode == "second_parent" and f.parent:
                    dst = rng.choice(
                        [e for e in f.parent if e in self.live] or f.elements
                    )
                elif mode == "tmp" and self.tmps:
                    src = rng.choice(self.tmps) if rng.random() < 0.5 else src
                    dst = rng.choice(self.tmps) if rng.random() < 0.5 else dst
                self.create_rel("Contains", src, dst)
            elif kind == "link":
                self.create_rel("Link", self.any_element(), self.any_element())
            elif kind == "disconnect":
                self.add({"kind": "delete_relationship", "id": self.any_rel()})
            elif kind == "recreate_element":
                eid = self.pick_by_shape()
                self.add({"kind": "delete_element", "id": eid})
                gone = {eid, *f.descendants(eid)}
                self.dead.extend(sorted(gone & set(self.live)))
                self.live = [e for e in self.live if e not in gone]
                self.create_element(eid)
            elif kind == "recreate_rel":
                rid = self.any_rel()
                self.add({"kind": "delete_relationship", "id": rid})
                typ = "Contains" if rid in f.contains else "Link"
                src, dst = f.ends.get(rid, (self.any_element(), self.any_element()))
                if not self.clean or src not in self.live or dst not in self.live:
                    src, dst = self.any_element(), self.any_element()
                self.create_rel(typ, src, dst, rid)
            elif kind == "attach_then_delete":
                x, c = self.any_element(), self.any_element()
                if self.clean:
                    # a root that is not yet below x, preferably with a subtree
                    roots = [e for e in self.live if e not in f.parent]
                    c = rng.choice(
                        [e for e in roots if e in f.children] or roots or [c]
                    )
                    outside = [
                        e for e in self.live if e != c and e not in f.descendants(c)
                    ]
                    x = rng.choice(outside or [x])
                self.create_rel("Contains", x, c)
                self.add({"kind": "delete_element", "id": x})
            elif kind == "update_rel":
                links = [*f.links, *self.tmp_links]
                self.add(
                    {
                        "kind": "update_relationship",
                        "id": rng.choice(links) if links else "nope-rel",
                        "properties_patch": {"via": self.any_element()},
                    }
                )
            elif self.clean:
                continue
            else:  # cross_table_hint: an id that is the other table's
                if rng.random() < 0.5 and f.contains:
                    self.create_element(rng.choice([*f.contains, *f.links]))
                else:
                    self.create_rel(
                        "Link",
                        self.any_element(),
                        self.any_element(),
                        rng.choice(f.elements),
                    )
        return self.ops


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # one counter per Model, so the server's partial model (rebuilt every round)
    # and the oracle's full one make the same ids
    monkeypatch.setattr(model_mod, "Uuid7Generator", lambda: SequentialIdGenerator("g"))
    seed_default_project()
    return TestClient(create_app())


def _rows_equal_mirror(oracle: Oracle, why: str) -> None:
    from data_rover.api.session import get_registry

    mirror = get_registry().get(DEFAULT_PROJECT_ID).model
    assert mirror is not None
    want_e, want_r = oracle.rows()
    from dataclasses import asdict

    assert [asdict(e) for e in mirror.elements.values()] == want_e, f"{why}: mirror"
    assert [asdict(r) for r in mirror.relationships.values()] == want_r, (
        f"{why}: mirror"
    )


def test_a_commit_on_head_rows_equals_the_full_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.headers.update(AUTH_HEADERS)
    rounds: list[int] = []
    real_plan = commit_load.plan_load
    real_lock = content.lock_model_row

    def counting(*a: Any, **k: Any) -> Any:
        rounds.append(1)
        return real_plan(*a, **k)

    def new_request(*a: Any, **k: Any) -> Any:
        rounds.clear()  # the helper retries a request that lacked locks
        return real_lock(*a, **k)

    # every third seed runs with a planner that foresees no subtree and no
    # attachment, so the re-run loop answers real batches, one miss at a time
    blind = [False]
    real_scan = commit_load._scan
    real_subtree = commit_load.subtree_ids

    def shallow(
        db: Any, project_id: str, roots: Any, types: Any, skip: Any = ()
    ) -> Any:
        if blind[0]:
            return set(roots)
        return real_subtree(db, project_id, roots, types, skip)

    monkeypatch.setattr(commit_load, "subtree_ids", shallow)

    def scan(*a: Any, **k: Any) -> Any:
        named = real_scan(*a, **k)
        if blind[0]:
            named.attachments.clear()
        return named

    monkeypatch.setattr(commit_load, "plan_load", counting)
    monkeypatch.setattr(commit_load, "_scan", scan)
    monkeypatch.setattr(content, "lock_model_row", new_request)
    most = 0
    accepted = rejected = reverted = multi_round = 0
    multi_accepted = multi_rejected = 0
    for seed in SEEDS:
        why = f"seed {seed}"
        blind[0] = seed % 3 == 0
        monkeypatch.setattr(commit_load, "MAX_ROUNDS", 64 if blind[0] else 8)
        rng = random.Random(seed)
        text, facts = make_model(rng, seed)
        install(metamodel=MM, model=text)
        installed = head()
        oracle = Oracle(text)
        ops = Batch(rng, facts, f"s{seed}").build()
        want = oracle.run(model_ops(ops))
        r = post_commit(client, ops)
        most = max(most, len(rounds))
        if len(rounds) > 1:
            multi_round += 1
            if want.status == 200:
                multi_accepted += 1
            else:
                multi_rejected += 1
        assert r.status_code == want.status, f"{why}: {r.status_code} {r.text}"
        if want.status != 200:
            rejected += 1
            assert r.json() == want.body, why
            assert head() == installed, f"{why}: a rejected commit changed rows"
            assert_rows(oracle, DEFAULT_PROJECT_ID, f"{why} (rejected)")
            continue
        accepted += 1
        body = r.json()
        res = want.res
        assert res is not None
        assert body["model_rev"] == installed.rev + 1, why
        assert body["state_digest"] == want.digest, why
        assert body["id_map"] == res.id_map, why
        assert body["deleted_element_ids"] == list(res.deleted_element_ids), why
        assert body["deleted_relationship_ids"] == list(res.deleted_relationship_ids), (
            why
        )
        assert body["recreated_element_ids"] == list(res.recreated_element_ids), why
        assert body["recreated_relationship_ids"] == list(
            res.recreated_relationship_ids
        ), why
        assert [r["id"] for r in body["changed_relationships"]] == list(
            res.changed_relationship_ids
        ), why
        assert [e["id"] for e in body["changed_elements"]] == list(
            res.changed_element_ids
        ), why
        assert_rows(oracle, DEFAULT_PROJECT_ID, why)
        assert_commit_row(want, installed.rev + 1, DEFAULT_PROJECT_ID, why)
        _rows_equal_mirror(oracle, why)

        # revert: the oracle takes the batch's inverse back out
        undo = oracle.run(res.inverse_ops(), restore=True)
        rev = installed.rev + 1
        rv = client.post(
            f"/api/v1/projects/{DEFAULT_PROJECT_ID}/commits/revert",
            json={"target_rev": installed.rev, "base_rev": rev},
        )
        assert rv.status_code == undo.status, (
            f"{why} revert: {rv.status_code} {rv.text}"
        )
        if undo.status != 200:
            assert rv.json() == undo.body, f"{why} revert"
            assert_rows(oracle, DEFAULT_PROJECT_ID, f"{why} (revert rejected)")
            continue
        reverted += 1
        assert_rows(oracle, DEFAULT_PROJECT_ID, f"{why} (revert)")
        assert_commit_row(undo, rev + 1, DEFAULT_PROJECT_ID, f"{why} (revert)")
        _rows_equal_mirror(oracle, f"{why} (revert)")
        # the entities are the installed ones again
        back = head()
        assert {k: _content(v) for k, v in back.elements.items()} == {
            k: _content(v) for k, v in installed.elements.items()
        }, f"{why}: revert did not restore the elements"
        assert {k: _content(v) for k, v in back.relationships.items()} == {
            k: _content(v) for k, v in installed.relationships.items()
        }, f"{why}: revert did not restore the relationships"
        with session() as s:
            assert head_refs(s, DEFAULT_PROJECT_ID) == oracle.refs()
    print(
        f"differential: {accepted} accepted, {rejected} rejected, {reverted} reverted, "
        f"{multi_round} needed a second round ({multi_accepted} accepted, "
        f"{multi_rejected} refused), at most {most} rounds"
    )
    assert accepted >= 90 and rejected >= 60 and reverted >= 70
    assert multi_accepted >= 10 and multi_rejected >= 1


def _content(entity: dict[str, Any]) -> dict[str, Any]:
    """An entity as a revert restores it: ``rev`` is a change counter, not
    state."""
    return {k: v for k, v in entity.items() if k != "rev"}
