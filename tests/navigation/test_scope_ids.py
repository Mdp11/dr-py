"""`_scope_ids` returns the ASCENDING-ID list of the elements a scope selects —
the paging-determinism contract — while walking the model in insertion order
(no id set, no per-id lookup) and skipping the matcher when there are no
criteria. The differential test pins it against the set-based derivation on a
model whose insertion order is deliberately NOT id order."""

import random

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import (
    _match_nav_criterion,
    _scope_ids,
    evaluate,
)
from data_rover.core.navigation.schema import PathNavigation, Scope
from data_rover.core.search.criteria import Criterion, PropertyCriterion


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Node",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Building", extends="Node"),
            ElementType(name="Sensor", extends="Node"),
        ],
        relationships=[],
    )


def _contains(value: str) -> PropertyCriterion:
    return PropertyCriterion(type="property", name="name", op="contains", value=value)


def _exists() -> PropertyCriterion:
    return PropertyCriterion(type="property", name="name", op="exists")


def _unsorted_model() -> Model:
    """Insertion order z, m, a — id order a, m, z. `m` carries no name."""
    model = Model(_mm())
    z = model.restore_element("z", "Building")
    model.set_property(z, "name", "zeta")
    model.restore_element("m", "Sensor")
    a = model.restore_element("a", "Sensor")
    model.set_property(a, "name", "alpha")
    assert list(model.elements) == ["z", "m", "a"]
    return model


def _reference(mm: Metamodel, model: Model, scope: Scope) -> list[str]:
    """The set-based derivation: union of per-type sets (or every id), filter,
    sort. The oracle the new implementation must match exactly."""
    if scope.types:
        ids: set[str] = set()
        for type_name in scope.types:
            for concrete in mm.element_descendants(type_name):
                ids |= model.indexes.elements_by_type.get(concrete, set())
    else:
        ids = set(model.elements.keys())
    return sorted(
        i
        for i in ids
        if all(
            _match_nav_criterion(model, model.elements[i], c) for c in scope.criteria
        )
    )


def test_untyped_scope_is_sorted_by_id_not_insertion_order() -> None:
    model = _unsorted_model()
    assert _scope_ids(model.metamodel, model, Scope()) == ["a", "m", "z"]


def test_untyped_scope_with_criteria_filters_then_sorts() -> None:
    model = _unsorted_model()
    assert _scope_ids(model.metamodel, model, Scope(criteria=[_exists()])) == ["a", "z"]
    assert _scope_ids(model.metamodel, model, Scope(criteria=[_contains("et")])) == ["z"]
    assert _scope_ids(
        model.metamodel, model, Scope(criteria=[_exists(), _contains("q")])
    ) == []


def test_typed_scope_dedupes_overlapping_types_and_sorts() -> None:
    model = _unsorted_model()
    mm = model.metamodel
    # Node ⊇ Sensor: naming both must not duplicate the sensors.
    assert _scope_ids(mm, model, Scope(types=["Sensor", "Node"])) == ["a", "m", "z"]
    assert _scope_ids(mm, model, Scope(types=["Sensor"])) == ["a", "m"]
    assert _scope_ids(mm, model, Scope(types=["Sensor"], criteria=[_exists()])) == ["a"]
    assert _scope_ids(mm, model, Scope(types=["Nope"])) == []


def test_empty_model() -> None:
    model = Model(_mm())
    assert _scope_ids(model.metamodel, model, Scope()) == []
    assert _scope_ids(model.metamodel, model, Scope(criteria=[_exists()])) == []
    assert _scope_ids(model.metamodel, model, Scope(types=["Node"])) == []


def test_evaluate_untyped_start_yields_chains_in_id_order() -> None:
    model = _unsorted_model()
    defn = PathNavigation(kind="path", start=Scope(), steps=[])
    result = evaluate(model.metamodel, model, defn)
    assert result.chains == [("a",), ("m",), ("z",)]


def test_differential_against_set_based_derivation() -> None:
    rnd = random.Random(24)
    model = Model(_mm())
    mm = model.metamodel
    ids = [f"{rnd.getrandbits(32):08x}" for _ in range(300)]
    rnd.shuffle(ids)  # insertion order uncorrelated with id order
    for eid in ids:
        el = model.restore_element(eid, rnd.choice(["Building", "Sensor"]))
        if rnd.random() < 0.8:
            model.set_property(
                el, "name", "".join(rnd.choice("abcde ") for _ in range(6))
            )
    assert list(model.elements) != sorted(model.elements)
    type_choices: list[list[str]] = [
        [], ["Node"], ["Building"], ["Sensor"], ["Building", "Node"], ["Sensor", "Building"],
    ]
    criteria_choices: list[list[Criterion]] = [
        [], [_exists()], [_contains("a")], [_contains("a"), _contains("e")], [_contains("zz")],
    ]
    for types in type_choices:
        for criteria in criteria_choices:
            scope = Scope(types=types, criteria=criteria)
            assert _scope_ids(mm, model, scope) == _reference(mm, model, scope), (
                types,
                criteria,
            )
