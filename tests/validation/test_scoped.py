"""Differential check of incremental (dirty-set scoped) validation.

THE key correctness gate for Phase B: seeded random op sequences run through
the Model mutation boundary with a DirtyCollector around each op; after every
op the dirty scope is re-validated and spliced into a ValidationState, which
must then equal a from-scratch FULL validation of the current model. Any
under-scoped dirty set shows up as a stale/missing issue here.

Containment-cycle issues are excluded from the equality (and covered by
dedicated tests below): a full run reports ONE cycle issue naming an
arbitrary representative element, while a scoped run names the dirty
entities whose parent chains reach the cycle — a documented asymmetry of the
scoped-pipeline contract (see core/validation/dirty.py).
"""

from __future__ import annotations

import random

import pytest

from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import DirtyCollector
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from .test_pipeline_differential import _metamodel

OPS_PER_SEED = 200
SEEDS = (1, 7, 20260610)

_CONCRETE_TYPES = ("Block", "Part", "Doc", "Hub", "Node")
_PROPS_BY_TYPE: dict[str, tuple[str, ...]] = {
    "Block": ("name", "count", "code", "ref", "tags"),
    "Part": ("name",),
    "Doc": ("title",),
    "Hub": ("name",),
    "Node": ("name",),
}
_REL_TYPES = ("HasPart", "Owns", "Link", "R2")


def _value_pool(rng: random.Random, model: Model, prop: str):
    """A mix of valid and violating values so every validator kind fires."""
    if prop == "name":
        return rng.choice(["A", "B", "C", "D", "E", None, 42])
    if prop == "count":
        return rng.choice([3, -5, 99, "bad"])
    if prop == "code":
        return rng.choice(["AB", "abc", "TOOLONG"])
    if prop == "ref":
        if model.elements and rng.random() < 0.7:
            return rng.choice(list(model.elements))
        return rng.choice(["missing-id", 42])
    if prop == "tags":
        return rng.choice([["a"], ["a", "b"], ["a", "b", "c"]])
    if prop == "title":
        return rng.choice(["T", "X"])
    raise AssertionError(prop)


def _random_op(
    rng: random.Random, model: Model, collector: DirtyCollector
) -> None:
    """Perform one random mutation, collecting its dirty contributions."""
    element_ids = list(model.elements)
    rel_ids = list(model.relationships)
    choices = ["create", "set_prop", "connect"]
    if element_ids:
        choices += ["set_prop", "connect", "delete"]
    if rel_ids:
        choices += ["disconnect", "set_rel_prop"]
    op = rng.choice(choices)

    if op == "create" or not element_ids:
        el = model.create_element(rng.choice(_CONCRETE_TYPES))
        collector.on_element_created(model, el.id)
        if rng.random() < 0.8:  # usually name it (missing name otherwise)
            collector.before_element_props_change(model, el.id)
            model.set_property(el, "name" if el.type_name != "Doc" else "title",
                               rng.choice(["A", "B", "C", "D"]))
            collector.after_element_props_change(model, el.id)
    elif op == "set_prop":
        eid = rng.choice(element_ids)
        el = model.get_element(eid)
        prop = rng.choice(_PROPS_BY_TYPE[el.type_name])
        collector.before_element_props_change(model, eid)
        model.set_property(el, prop, _value_pool(rng, model, prop))
        collector.after_element_props_change(model, eid)
    elif op == "connect":
        if len(element_ids) < 2:
            return
        rel_type = rng.choice(_REL_TYPES)
        source_id = rng.choice(element_ids)
        target_id = rng.choice(element_ids)
        collector.before_connect(model, rel_type, source_id, target_id)
        rel = model.connect(rel_type, source_id, target_id)
        collector.on_relationship_created(model, rel.id)
    elif op == "disconnect":
        rid = rng.choice(rel_ids)
        rel = model.get_relationship(rid)
        rel_type, target_id = rel.type_name, rel.target_id
        collector.before_disconnect(model, rid)
        model.disconnect(rid)
        collector.after_disconnect(model, rel_type, target_id)
    elif op == "set_rel_prop":
        rid = rng.choice(rel_ids)
        rel = model.get_relationship(rid)
        if rel.type_name == "Link":
            collector.on_relationship_props_changed(rid)
            model.set_property(rel, "label", rng.choice(["ok", None]))
        else:
            collector.on_relationship_props_changed(rid)  # still a valid set
    else:  # delete
        eid = rng.choice(element_ids)
        collector.before_element_delete(model, eid)
        model.delete_element(eid)


def _normalized(issues, *, drop_cycles: bool):
    return sorted(
        (i.severity.value, i.message, tuple(i.target_ids))
        for i in issues
        if not (drop_cycles and "Containment cycle" in i.message)
    )


def _seed_model(rng: random.Random, ids: SequentialIdGenerator) -> Model:
    model = Model(_metamodel(), id_generator=ids)
    for _ in range(30):
        el = model.create_element(rng.choice(_CONCRETE_TYPES))
        if el.type_name == "Doc":
            model.set_property(el, "title", rng.choice(["T", "X"]))
        else:
            model.set_property(el, "name", rng.choice(["A", "B", "C", "D"]))
    element_ids = list(model.elements)
    for _ in range(20):
        model.connect(
            rng.choice(_REL_TYPES), rng.choice(element_ids), rng.choice(element_ids)
        )
    return model


@pytest.mark.parametrize("seed", SEEDS)
def test_randomized_ops_incremental_state_matches_full_validation(seed: int):
    rng = random.Random(seed)
    model = _seed_model(rng, SequentialIdGenerator("n"))
    pipeline = default_pipeline()

    state = ValidationState()
    state.set_full(pipeline.validate(model, Scope.all()))

    for step in range(OPS_PER_SEED):
        collector = DirtyCollector()
        _random_op(rng, model, collector)
        dirty = list(collector.ids)
        state.replace(dirty, pipeline.validate(model, collector.to_scope()))

        expected = pipeline.validate(model, Scope.all())
        assert _normalized(state.all_issues(), drop_cycles=True) == _normalized(
            expected, drop_cycles=True
        ), f"divergence at seed={seed} step={step}"


def test_containment_cycle_via_connect_is_detected_by_scoped_revalidation():
    """B2 caveat: a cycle created by a containment connect must surface in the
    scoped re-validation because both endpoints are dirty and their parent
    chains reach the new cycle."""
    model = Model(_metamodel(), id_generator=SequentialIdGenerator("n"))
    a = model.create_element("Block")
    model.set_property(a, "name", "a")
    b = model.create_element("Block")
    model.set_property(b, "name", "b")
    c = model.create_element("Block")
    model.set_property(c, "name", "c")
    model.connect("HasPart", a.id, b.id)
    model.connect("HasPart", b.id, c.id)

    pipeline = default_pipeline()
    state = ValidationState()
    state.set_full(pipeline.validate(model, Scope.all()))
    assert not any("Containment cycle" in i.message for i in state.all_issues())

    # close the loop: c contains a
    collector = DirtyCollector()
    collector.before_connect(model, "HasPart", c.id, a.id)
    rel = model.connect("HasPart", c.id, a.id)
    collector.on_relationship_created(model, rel.id)

    dirty = list(collector.ids)
    scoped_issues = pipeline.validate(model, collector.to_scope())
    state.replace(dirty, scoped_issues)

    cycle_issues = [
        i for i in state.all_issues() if "Containment cycle" in i.message
    ]
    assert cycle_issues, "scoped revalidation must report the new cycle"
    # the dirty endpoints are the reported representatives
    assert {i.target_ids[0] for i in cycle_issues} <= set(dirty)
