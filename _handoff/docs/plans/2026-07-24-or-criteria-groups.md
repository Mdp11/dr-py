# OR-able Criteria Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one OR-group criterion variant (`{type: "any_of", criteria: [...]}`) to the shared condition model so every filter surface — advanced search, navigation start scope, navigation "Keep only…", table scope — can express OR between conditions.

**Architecture:** The condition vocabulary lives once per side: `src/data_rover/core/search/criteria.py` (pydantic union + matchers) mirrored by `frontend/src/lib/search/types.ts` + `frontend/src/lib/search/evaluate.ts`. All four surfaces hold `list[Criterion]`, so widening the union propagates everywhere. No-nesting is structural (group members are typed as the leaf-only union). Empty group = deliberate no-op (matches everything). UI: one new `CriterionGroupRow.svelte` reused by the three host editors.

**Tech Stack:** Python 3.14 / pydantic v2 / FastAPI; Svelte 5 (runes) + TypeScript; pytest; vitest (happy-dom).

**Spec:** `docs/superpowers/specs/2026-07-24-or-criteria-groups-design.md`

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest …` for Python tests; frontend npm scripts MUST run from inside `frontend/` (`pixi run -e frontend bash -c 'cd frontend && npm test'` — the bare `pixi run -e frontend npm test` fails).
- Lint gate is all three: `pixi run dr-tidy` runs ruff-format+lint, mypy, AND pyright, plus frontend checks. All must pass before the final commit.
- Python 3.14 target — use modern syntax (PEP 604 unions, `from __future__ import annotations` already present in touched files).
- JS-parity contract: backend matchers and `frontend/src/lib/search/evaluate.ts` must return byte-identical results. Every semantic added to one side is added to the other with a mirrored test.
- Empty `any_of` group matches EVERYTHING (no-op) — an explicit override of `any([]) is False`, on both sides.
- No `schema_version` bumps (navigation stays 3, table stays 1) — the change is additive.
- Preserve the dense-docstring style of touched core files (invariants explained inline).
- Commit after every task with the message given in its final step.

---

### Task 1: Backend vocabulary — `AnyOfCriterion` + matcher semantics

**Files:**
- Modify: `src/data_rover/core/search/criteria.py` (union split + group class + matcher branches)
- Modify: `src/data_rover/api/search.py` (re-export)
- Create: `tests/search/__init__.py` (empty)
- Test: `tests/search/test_criteria.py` (new)

**Interfaces:**
- Consumes: existing `match_element(model, e, c)`, `match_relationship(model, r, c)`, leaf criterion classes.
- Produces: `LeafCriterion` (type alias: the previous 7-member union), `AnyOfCriterion` (pydantic model, fields `type: Literal["any_of"]`, `criteria: list[LeafCriterion]`), widened `Criterion` union including `AnyOfCriterion`. Tasks 2–3 import `AnyOfCriterion` from `data_rover.core.search.criteria`.

- [ ] **Step 1: Write the failing tests**

Create `tests/search/__init__.py` (empty file), then `tests/search/test_criteria.py`:

```python
"""AnyOfCriterion (OR group) matcher + wire-format tests.

The group is the one addition to the shared condition vocabulary: it matches
iff ANY member matches; an EMPTY group is a deliberate no-op (matches
everything); members are leaves only — nesting is structurally
unrepresentable, so a nested group fails validation.
"""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.search.criteria import (
    AnyOfCriterion,
    Criterion,
    EntityTypeCriterion,
    NameIdCriterion,
    PropertyCriterion,
    match_element,
    match_relationship,
)

CRITERION_ADAPTER: TypeAdapter[Criterion] = TypeAdapter(Criterion)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Thing",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="status", datatype="string"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(name="Link", source="Thing", target="Thing"),
        ],
    )


def _model() -> tuple[Model, dict[str, str]]:
    """t1 Alpha/active, t2 Beta/pending, t3 legacy-x/closed; one Link t1->t2."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for key, name, status in [
        ("t1", "Alpha", "active"),
        ("t2", "Beta", "pending"),
        ("t3", "legacy-x", "closed"),
    ]:
        el = model.create_element("Thing")
        model.set_property(el, "name", name)
        model.set_property(el, "status", status)
        ids[key] = el.id
    model.connect("Link", ids["t1"], ids["t2"])
    return model, ids


def _status(value: str) -> PropertyCriterion:
    return PropertyCriterion(type="property", name="status", op="equals", value=value)


def test_any_of_matches_when_any_member_matches() -> None:
    model, ids = _model()
    group = AnyOfCriterion(
        type="any_of", criteria=[_status("active"), _status("pending")]
    )
    matched = [k for k, i in ids.items() if match_element(model, model.elements[i], group)]
    assert matched == ["t1", "t2"]


def test_any_of_mixes_member_kinds() -> None:
    model, ids = _model()
    group = AnyOfCriterion(
        type="any_of",
        criteria=[
            _status("pending"),
            NameIdCriterion(type="name_id", field="name", op="contains", value="legacy"),
        ],
    )
    matched = [k for k, i in ids.items() if match_element(model, model.elements[i], group)]
    assert matched == ["t2", "t3"]


def test_empty_any_of_is_a_no_op_matching_everything() -> None:
    model, ids = _model()
    group = AnyOfCriterion(type="any_of", criteria=[])
    assert all(match_element(model, model.elements[i], group) for i in ids.values())


def test_any_of_with_no_matching_member_matches_nothing() -> None:
    model, ids = _model()
    group = AnyOfCriterion(type="any_of", criteria=[_status("nope")])
    assert not any(match_element(model, model.elements[i], group) for i in ids.values())


def test_any_of_on_relationships() -> None:
    model, _ids = _model()
    rel = next(iter(model.relationships.values()))
    yes = AnyOfCriterion(
        type="any_of", criteria=[EntityTypeCriterion(type="entity_type", names=["Link"])]
    )
    no = AnyOfCriterion(
        type="any_of", criteria=[EntityTypeCriterion(type="entity_type", names=["Other"])]
    )
    assert match_relationship(model, rel, yes)
    assert not match_relationship(model, rel, no)


def test_wire_parse_roundtrip() -> None:
    parsed = CRITERION_ADAPTER.validate_python(
        {
            "type": "any_of",
            "criteria": [
                {"type": "property", "name": "status", "op": "equals", "value": "active"}
            ],
        }
    )
    assert isinstance(parsed, AnyOfCriterion)
    assert isinstance(parsed.criteria[0], PropertyCriterion)


def test_nested_any_of_is_rejected() -> None:
    with pytest.raises(ValidationError):
        CRITERION_ADAPTER.validate_python(
            {"type": "any_of", "criteria": [{"type": "any_of", "criteria": []}]}
        )
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/search/test_criteria.py -v`
Expected: FAIL at import time — `ImportError: cannot import name 'AnyOfCriterion'`.

- [ ] **Step 3: Implement the vocabulary change**

In `src/data_rover/core/search/criteria.py`, replace the existing `Criterion = Annotated[...]` block (currently right after `EndpointTypeCriterion`) with:

```python
LeafCriterion = Annotated[
    EntityTypeCriterion
    | PropertyCriterion
    | NameIdCriterion
    | RelationCountCriterion
    | OrphanCriterion
    | ConnectedToTypeCriterion
    | EndpointTypeCriterion,
    Field(discriminator="type"),
]
"""Every non-group criterion — the only members an OR group may hold."""


class AnyOfCriterion(BaseModel):
    """OR group: matches iff ANY member matches. Members are LEAVES only —
    nesting is structurally unrepresentable (``criteria: list[LeafCriterion]``),
    so a nested group fails validation at every API boundary that parses
    criteria. An EMPTY group is a deliberate NO-OP (matches everything): it is
    a transient editing state and must not blank a half-configured table or
    navigation — the same tolerant stance as an unconfigured table
    ``NavigationSource``. This overrides literal ``any([]) is False``; the
    matchers here and the client evaluator special-case it identically."""

    type: Literal["any_of"]
    criteria: list[LeafCriterion] = Field(default_factory=list)


Criterion = Annotated[
    EntityTypeCriterion
    | PropertyCriterion
    | NameIdCriterion
    | RelationCountCriterion
    | OrphanCriterion
    | ConnectedToTypeCriterion
    | EndpointTypeCriterion
    | AnyOfCriterion,
    Field(discriminator="type"),
]
```

Then add the group branch at the TOP of both matchers (before the first `isinstance` check in each):

```python
def match_element(model: Model, e: Element, c: Criterion) -> bool:
    if isinstance(c, AnyOfCriterion):
        # empty group = configured-nothing no-op (see AnyOfCriterion docstring)
        return not c.criteria or any(match_element(model, e, m) for m in c.criteria)
    ...
```

```python
def match_relationship(model: Model, r: Relationship, c: Criterion) -> bool:
    if isinstance(c, AnyOfCriterion):
        return not c.criteria or any(match_relationship(model, r, m) for m in c.criteria)
    ...
```

Finally, extend the module docstring's first line context with one sentence (append to the first paragraph): `Criteria combine with AND at every call site; the single OR construct is ``AnyOfCriterion`` (a flat, leaf-only group).`

- [ ] **Step 4: Re-export from `api/search.py`**

In `src/data_rover/api/search.py`, add `AnyOfCriterion,` and `LeafCriterion,` to the `from data_rover.core.search.criteria import (...)` block (alphabetical position: `AnyOfCriterion` first, `LeafCriterion` after `EntityTypeCriterion`) and add the same two names to `__all__` (alphabetical).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/search/test_criteria.py -v`
Expected: 8 passed.

- [ ] **Step 6: Run the full core suite + lint**

Run: `pixi run core-test` then `pixi run core-lint`
Expected: all pass (no existing behavior changed — the group branch is a new isinstance arm).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/core/search/criteria.py src/data_rover/api/search.py tests/search/
git commit -m "feat(search): add AnyOfCriterion OR group to the shared condition vocabulary"
```

---

### Task 2: Navigation — existence-gated recursion in `_match_nav_criterion`

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py` (`_match_nav_criterion`, ~line 216)
- Test: `tests/navigation/test_evaluate_path.py` (append)

**Interfaces:**
- Consumes: `AnyOfCriterion` from `data_rover.core.search.criteria` (Task 1).
- Produces: navigation `Scope`/`FilterStep` criteria accept groups with per-MEMBER existence gating. No new names.

- [ ] **Step 1: Write the failing tests**

Append to `tests/navigation/test_evaluate_path.py` (the file already defines `_fixture`, `_path`, `_rel`, and imports `evaluate`; both `_path` and step dicts go through the wire adapter, so plain dicts are the criteria format):

```python
def test_start_scope_any_of_group() -> None:
    model, ids = _fixture()
    nav = _path(start={"kind": "scope", "types": [],
                       "criteria": [{"type": "any_of", "criteria": [
                           {"type": "property", "name": "name",
                            "op": "equals", "value": "Plant 1"},
                           {"type": "property", "name": "name",
                            "op": "equals", "value": "T-2"},
                       ]}]},
                steps=[])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == sorted([(ids["b1"],), (ids["s2"],)])


def test_filter_step_any_of_members_are_existence_gated() -> None:
    model, ids = _fixture()
    # `missing` is set on NO element: ungated, `not_equals X` would coerce the
    # absent value to "" and match EVERYTHING, making the group always-true.
    # Gated, that member matches nothing — so the group's fate rides on its
    # other member (name == T-1).
    group = {"type": "any_of", "criteria": [
        {"type": "property", "name": "missing", "op": "not_equals", "value": "X"},
        {"type": "property", "name": "name", "op": "equals", "value": "T-1"},
    ]}
    nav = _path(start={"kind": "scope", "types": ["Building"]},
                steps=[_rel("Owns"), {"kind": "filter", "criteria": [group]}])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(ids["b1"], ids["s1"])]


def test_filter_step_empty_any_of_is_no_op() -> None:
    model, ids = _fixture()
    nav = _path(start={"kind": "scope", "types": ["Building"]},
                steps=[_rel("Owns"), {"kind": "filter",
                                      "criteria": [{"type": "any_of", "criteria": []}]}])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == sorted([
        (ids["b1"], ids["s1"]), (ids["b1"], ids["s2"]), (ids["b2"], ids["s3"]),
    ])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_evaluate_path.py -k any_of -v`
Expected: `test_start_scope_any_of_group` and `test_filter_step_empty_any_of_is_no_op` PASS already (they flow through `match_element`, which Task 1 taught about groups) — but `test_filter_step_any_of_members_are_existence_gated` FAILS: the group bypasses `_match_nav_criterion`'s per-member gate, the `missing not_equals X` member coerces to `""` and matches everything, so all three chains survive instead of one.

(If the first two unexpectedly fail, stop and debug — that means Task 1 regressed.)

- [ ] **Step 3: Implement the recursion**

In `src/data_rover/core/navigation/evaluate.py`:

1. Extend the import (line ~33): `from data_rover.core.search.criteria import AnyOfCriterion, PropertyCriterion, match_element`
2. Add a group branch at the top of `_match_nav_criterion`, and extend its docstring:

```python
def _match_nav_criterion(model: Model, element: Element, criterion) -> bool:
    """Navigation criterion match. Property criteria are EXISTENCE-GATED: the
    element must actually carry the property (except `exists`/`is_empty`, which
    handle absence explicitly). This intentionally diverges from the shared
    search matcher's coerce-missing-to-'' semantics — `core/search` is
    untouched, so `/model/search` stays byte-identical. An `any_of` group
    recurses HERE (not through the shared matcher) so each member is gated
    exactly as a top-level criterion would be; an empty group stays the
    shared no-op (matches everything)."""
    if isinstance(criterion, AnyOfCriterion):
        return not criterion.criteria or any(
            _match_nav_criterion(model, element, m) for m in criterion.criteria
        )
    if isinstance(criterion, PropertyCriterion) and criterion.op not in (
        "exists",
        "is_empty",
    ):
        if criterion.name not in element.properties:
            return False
    return match_element(model, element, criterion)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/ -v`
Expected: all pass, including the 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_evaluate_path.py
git commit -m "feat(navigation): existence-gate any_of group members in scope and keep-only filters"
```

---

### Task 3: Boundary coverage — search route + table scope (tests only)

No production code: `SearchQueryIn.criteria` and `ScopeRows.criteria` are `list[Criterion]`, so Task 1's union widening already flows through both boundaries. This task pins that with tests a reviewer can gate on.

**Files:**
- Test: `tests/api/test_search_routes.py` (append)
- Test: `tests/table/test_build_rows.py` (append)

**Interfaces:**
- Consumes: the wire format `{"type": "any_of", "criteria": [...]}` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the search-route tests**

Append to `tests/api/test_search_routes.py` (helpers `_load`, `_person`, `_search`, `_ids`, the `client` fixture, and the `API` prefix constant already exist in the file):

```python
def test_search_any_of_group_ors_members_and_ands_with_siblings(
    client: TestClient,
) -> None:
    _load(
        client,
        [
            _person("p1", "Ann", age=30),
            _person("p2", "Bob", age=40),
            _person("p3", "Cy", age=20),
            _company("c1", "Acme"),
        ],
        [],
    )
    page = _search(
        client,
        {
            "target": "element",
            "criteria": [
                {"type": "entity_type", "names": ["Person"]},
                {"type": "any_of", "criteria": [
                    {"type": "property", "name": "age", "op": "equals", "value": "30"},
                    {"type": "name_id", "field": "name", "op": "contains", "value": "Cy"},
                ]},
            ],
        },
    )
    assert _ids(page) == ["p1", "p3"]


def test_search_empty_any_of_group_is_no_op(client: TestClient) -> None:
    _load(client, [_person("p1", "Ann"), _person("p2", "Bob")], [])
    page = _search(
        client,
        {"target": "element", "criteria": [{"type": "any_of", "criteria": []}]},
    )
    assert _ids(page) == ["p1", "p2"]


def test_search_nested_any_of_rejected(client: TestClient) -> None:
    res = client.post(
        f"{API}/model/search",
        json={
            "target": "element",
            "criteria": [{"type": "any_of",
                          "criteria": [{"type": "any_of", "criteria": []}]}],
        },
    )
    assert res.status_code == 422
```

- [ ] **Step 2: Write the table-scope test**

Append to `tests/table/test_build_rows.py` (helpers `_mm`, `_fixture`, `TABLE_ADAPTER`, `build_rows` already imported there):

```python
def test_scope_rows_any_of_criteria_group():
    mm = _mm(); model, ids = _fixture()
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": [
            {"type": "any_of", "criteria": [
                {"type": "property", "name": "name", "op": "equals", "value": "Root"},
                {"type": "property", "name": "name", "op": "equals", "value": "Leaf"},
            ]},
        ]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, truncated = build_rows(mm, model, defn)
    assert not truncated
    assert sorted(keys) == sorted([(ids["root"],), (ids["leaf"],)])
```

- [ ] **Step 3: Run both files to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_search_routes.py tests/table/test_build_rows.py -v`
Expected: all pass on the first run (the production paths were finished in Tasks 1–2). If a new test fails, the boundary does NOT flow the union — debug before proceeding, do not adapt the test.

- [ ] **Step 4: Commit**

```bash
git add tests/api/test_search_routes.py tests/table/test_build_rows.py
git commit -m "test(search,table): pin any_of group behavior at the search route and table scope"
```

---

### Task 4: Frontend vocabulary + evaluator parity

**Files:**
- Modify: `frontend/src/lib/search/types.ts`
- Modify: `frontend/src/lib/search/evaluate.ts`
- Test: `frontend/src/lib/search/__tests__/evaluate.test.ts` (append)
- Test: `frontend/src/lib/search/__tests__/types.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks (frontend mirror is standalone).
- Produces: `LeafCriterion`, `AnyOfCriterion` = `{ type: 'any_of'; criteria: LeafCriterion[] }`, widened `Criterion`, `newCriterion('any_of')`, `CRITERION_LABELS.any_of === 'Any of'`, `criteriaForKind` including `'any_of'` for both targets, recursive `pruneCriteria`. Task 5 imports `AnyOfCriterion` and `LeafCriterion` from `$lib/search/types`.

- [ ] **Step 1: Write the failing evaluator tests**

Append to `frontend/src/lib/search/__tests__/evaluate.test.ts` (helpers `el`, `rel`, `model`, `ids` exist at the top of the file; add `Criterion` to the type import from `'../types'`):

```ts
describe('runQuery — any_of group', () => {
	const m = model(
		[
			el('e1', 'Block', { status: 'active' }),
			el('e2', 'Block', { status: 'pending' }),
			el('e3', 'Port', { status: 'closed', name: 'legacy-x' })
		],
		[rel('r1', 'e1', 'e2', 'Link'), rel('r2', 'e2', 'e3', 'Wire')]
	);
	const status = (value: string): Criterion => ({
		type: 'property',
		name: 'status',
		op: 'equals',
		value
	});

	it('matches when any member matches', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'any_of', criteria: [status('active'), status('pending')] }]
				},
				m
			)
		).toEqual(['e1', 'e2']);
	});

	it('mixes member kinds', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{
							type: 'any_of',
							criteria: [
								status('pending'),
								{ type: 'name_id', field: 'name', op: 'contains', value: 'legacy' }
							]
						}
					]
				},
				m
			)
		).toEqual(['e2', 'e3']);
	});

	it('empty group is a no-op (matches everything)', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'any_of', criteria: [] }] }, m)
		).toEqual(['e1', 'e2', 'e3']);
	});

	it('is ANDed with sibling criteria', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'entity_type', names: ['Block'] },
						{ type: 'any_of', criteria: [status('active'), status('closed')] }
					]
				},
				m
			)
		).toEqual(['e1']);
	});

	it('applies to relationship queries', () => {
		expect(
			ids(
				{
					target: 'relationship',
					criteria: [
						{
							type: 'any_of',
							criteria: [
								{ type: 'entity_type', names: ['Wire'] },
								{ type: 'endpoint_type', endpoint: 'source', names: ['Nope'] }
							]
						}
					]
				},
				m
			)
		).toEqual(['r2']);
	});
});
```

- [ ] **Step 2: Write the failing vocabulary tests**

Create `frontend/src/lib/search/__tests__/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { criteriaForKind, newCriterion, pruneCriteria, type Criterion } from '../types';

describe('any_of in the criterion vocabulary', () => {
	it('newCriterion builds an empty group', () => {
		expect(newCriterion('any_of')).toEqual({ type: 'any_of', criteria: [] });
	});
	it('is offered for both targets', () => {
		expect(criteriaForKind('element')).toContain('any_of');
		expect(criteriaForKind('relationship')).toContain('any_of');
	});
});

describe('pruneCriteria recurses into groups', () => {
	it('drops inapplicable members and keeps the rest', () => {
		const criteria: Criterion[] = [
			{
				type: 'any_of',
				criteria: [
					{ type: 'orphan' },
					{ type: 'property', name: 'status', op: 'equals', value: 'x' }
				]
			}
		];
		expect(pruneCriteria(criteria, 'relationship')).toEqual([
			{
				type: 'any_of',
				criteria: [{ type: 'property', name: 'status', op: 'equals', value: 'x' }]
			}
		]);
	});
	it('drops a group emptied by pruning', () => {
		const criteria: Criterion[] = [
			{ type: 'entity_type', names: [] },
			{ type: 'any_of', criteria: [{ type: 'orphan' }] }
		];
		expect(pruneCriteria(criteria, 'relationship')).toEqual([
			{ type: 'entity_type', names: [] }
		]);
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/search'`
Expected: FAIL — TS errors on `'any_of'` (not in the `Criterion` union) and the new assertions.

- [ ] **Step 4: Implement `types.ts`**

In `frontend/src/lib/search/types.ts`:

1. Rename today's `Criterion` union to `LeafCriterion` and rebuild `Criterion`:

```ts
export type LeafCriterion =
	| { type: 'entity_type'; names: string[] }
	| { type: 'property'; name: string; datatype?: string | null; op: PropertyOp; value: string }
	| { type: 'name_id'; field: 'name' | 'id'; op: TextOp; value: string }
	| { type: 'relation_count'; op: CountOp; count: number; direction: Direction; relTypes: string[] }
	| { type: 'orphan' }
	| { type: 'connected_to_type'; direction: Direction; names: string[] }
	| { type: 'endpoint_type'; endpoint: 'source' | 'target'; names: string[] };

/** OR group: matches iff ANY member matches; an EMPTY group is a no-op that
 * matches everything (transient editing state — mirrors the backend's
 * AnyOfCriterion docstring). Members are leaves only: no nesting, enforced
 * structurally on both sides of the wire. */
export type AnyOfCriterion = { type: 'any_of'; criteria: LeafCriterion[] };

export type Criterion = LeafCriterion | AnyOfCriterion;
```

2. `CRITERION_LABELS` gains `any_of: 'Any of'` (the `Record<CriterionType, string>` type forces this once the union widens).
3. Append `'any_of'` to BOTH `ELEMENT_CRITERIA` and `RELATIONSHIP_CRITERIA` (last position — display order).
4. `newCriterion` gains a case:

```ts
		case 'any_of':
			return { type, criteria: [] };
```

5. Replace `pruneCriteria` with the recursive version:

```ts
/** Drop criteria that do not apply to `target` (used when switching kind).
 * Recurses into `any_of` groups: inapplicable MEMBERS are dropped, and a
 * group emptied by pruning is dropped with them (an always-empty leftover
 * would otherwise sit uneditable in the list). */
export function pruneCriteria(criteria: Criterion[], target: TargetKind): Criterion[] {
	const allowed = criteriaForKind(target);
	const out: Criterion[] = [];
	for (const c of criteria) {
		if (c.type === 'any_of') {
			const members = c.criteria.filter((m) => allowed.includes(m.type));
			if (members.length > 0) out.push({ ...c, criteria: members });
		} else if (allowed.includes(c.type)) {
			out.push(c);
		}
	}
	return out;
}
```

- [ ] **Step 5: Implement `evaluate.ts`**

In `frontend/src/lib/search/evaluate.ts`, add a case to BOTH matchers — the `default:` no-op arm must never see a group (an OR over a vacuous-true member would match everything):

In `matchElement`, before `default:`:

```ts
		case 'any_of':
			// empty group = configured-nothing no-op; mirrors the backend matcher.
			return c.criteria.length === 0 || c.criteria.some((m) => matchElement(e, m, ctx));
```

In `matchRelationship`, before `default:`:

```ts
		case 'any_of':
			return c.criteria.length === 0 || c.criteria.some((m) => matchRelationship(r, m, ctx));
```

- [ ] **Step 6: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/search'`
Expected: all pass (existing + new).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/search/
git commit -m "feat(frontend/search): mirror the any_of OR group in the client vocabulary and evaluator"
```

---

### Task 5: UI — `CriterionGroupRow` + the three host editors

**Files:**
- Create: `frontend/src/lib/components/Sidebar/CriterionGroupRow.svelte`
- Modify: `frontend/src/lib/components/Sidebar/CriterionRow.svelte` (narrow to `LeafCriterion`)
- Modify: `frontend/src/lib/components/Sidebar/AdvancedSearchDialog.svelte`
- Modify: `frontend/src/lib/components/Navigation/ScopeEditor.svelte` (also serves table scope via `RowSourceEditor`)
- Modify: `frontend/src/lib/components/Navigation/FilterStepRow.svelte`
- Test: `frontend/src/lib/components/Sidebar/__tests__/criterion-group-row.test.ts` (new; dir is new too)
- Test: `frontend/src/lib/components/Navigation/__tests__/scope-editor-group.test.ts` (new)

**Interfaces:**
- Consumes: `AnyOfCriterion`, `LeafCriterion`, `Criterion`, `newCriterion`, `criteriaForKind`, `CRITERION_LABELS` from `$lib/search/types` (Task 4).
- Produces: `CriterionGroupRow` with props `{ criterion: AnyOfCriterion; index: number; target: TargetKind; onChange: (index: number, next: Criterion) => void; onRemove: (index: number) => void; propertyNames?: string[] | null }` — same host contract as `CriterionRow`, so hosts branch on `criterion.type` only.

- [ ] **Step 1: Write the failing component tests**

Create `frontend/src/lib/components/Sidebar/__tests__/criterion-group-row.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnyOfCriterion } from '$lib/search/types';
import CriterionGroupRow from '../CriterionGroupRow.svelte';

let component: Record<string, unknown> | null = null;
afterEach(() => {
	if (component) unmount(component);
	component = null;
	document.body.innerHTML = '';
});

function mountRow(criterion: AnyOfCriterion) {
	const onChange = vi.fn();
	const onRemove = vi.fn();
	component = mount(CriterionGroupRow, {
		target: document.body,
		props: { criterion, index: 3, target: 'element' as const, onChange, onRemove }
	});
	flushSync();
	return { onChange, onRemove };
}

it('renders the header, the empty hint, and no member rows when empty', () => {
	mountRow({ type: 'any_of', criteria: [] });
	expect(document.body.textContent).toContain('Any of');
	expect(document.body.textContent).toContain('filters nothing');
	expect(document.querySelectorAll('[aria-label="Remove criterion"]').length).toBe(0);
});

it('renders one member row per member', () => {
	mountRow({
		type: 'any_of',
		criteria: [
			{ type: 'property', name: 'a', op: 'equals', value: '1' },
			{ type: 'name_id', field: 'name', op: 'contains', value: 'x' }
		]
	});
	expect(document.querySelectorAll('[aria-label="Remove criterion"]').length).toBe(2);
});

it('removing a member patches the group in place', () => {
	const { onChange } = mountRow({
		type: 'any_of',
		criteria: [
			{ type: 'property', name: 'a', op: 'equals', value: '1' },
			{ type: 'property', name: 'b', op: 'equals', value: '2' }
		]
	});
	const removes = document.querySelectorAll<HTMLButtonElement>('[aria-label="Remove criterion"]');
	removes[0].click();
	flushSync();
	expect(onChange).toHaveBeenCalledWith(3, {
		type: 'any_of',
		criteria: [{ type: 'property', name: 'b', op: 'equals', value: '2' }]
	});
});

it('the group remove button reports the group index', () => {
	const { onRemove } = mountRow({ type: 'any_of', criteria: [] });
	document.body.querySelector<HTMLButtonElement>('[aria-label="Remove group"]')!.click();
	flushSync();
	expect(onRemove).toHaveBeenCalledWith(3);
});
```

Create `frontend/src/lib/components/Navigation/__tests__/scope-editor-group.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { NavScope } from '$lib/api/types';
import ScopeEditor from '../ScopeEditor.svelte';

let component: Record<string, unknown> | null = null;
afterEach(() => {
	if (component) unmount(component);
	component = null;
	document.body.innerHTML = '';
});

it('"+ OR group" appends an empty any_of criterion', () => {
	const onChange = vi.fn();
	const scope: NavScope = { kind: 'scope', types: [], criteria: [] };
	component = mount(ScopeEditor, { target: document.body, props: { scope, onChange } });
	flushSync();
	const btn = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === '+ OR group'
	);
	if (!btn) throw new Error('"+ OR group" button not found');
	btn.click();
	flushSync();
	expect(onChange).toHaveBeenCalledWith({
		kind: 'scope',
		types: [],
		criteria: [{ type: 'any_of', criteria: [] }]
	});
});

it('an any_of criterion renders as a group row, not a CriterionRow', () => {
	const scope: NavScope = {
		kind: 'scope',
		types: [],
		criteria: [{ type: 'any_of', criteria: [] }]
	};
	component = mount(ScopeEditor, {
		target: document.body,
		props: { scope, onChange: vi.fn() }
	});
	flushSync();
	expect(document.querySelector('[data-testid="criterion-group"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- criterion-group scope-editor-group'`
Expected: FAIL — `CriterionGroupRow.svelte` does not exist; the ScopeEditor test finds no "+ OR group" button.

- [ ] **Step 3: Create `CriterionGroupRow.svelte`**

Create `frontend/src/lib/components/Sidebar/CriterionGroupRow.svelte` with this full content:

```svelte
<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		CRITERION_LABELS,
		criteriaForKind,
		newCriterion,
		type AnyOfCriterion,
		type Criterion,
		type CriterionType,
		type LeafCriterion,
		type TargetKind
	} from '$lib/search/types';
	import CriterionRow from './CriterionRow.svelte';

	// An "Any of" OR group: an indented list of leaf criteria, each edited by
	// the same CriterionRow the hosts use at top level. The host contract
	// (criterion/index/target/onChange/onRemove/propertyNames) is identical to
	// CriterionRow's, so hosts only branch on `criterion.type`.
	type Props = {
		criterion: AnyOfCriterion;
		index: number;
		target: TargetKind;
		onChange: (index: number, next: Criterion) => void;
		onRemove: (index: number) => void;
		/** Forwarded to member rows (navigation filter-step property scoping). */
		propertyNames?: string[] | null;
	};
	let { criterion, index, target, onChange, onRemove, propertyNames = null }: Props = $props();

	// Members are leaves only — never offer a nested group.
	const memberTypes = $derived(criteriaForKind(target).filter((t) => t !== 'any_of'));

	function patchMembers(members: LeafCriterion[]): void {
		onChange(index, { ...criterion, criteria: members });
	}
	function setMember(i: number, next: LeafCriterion): void {
		patchMembers(criterion.criteria.map((m, j) => (j === i ? next : m)));
	}
	function removeMember(i: number): void {
		patchMembers(criterion.criteria.filter((_, j) => j !== i));
	}
	function addMember(type: CriterionType): void {
		patchMembers([...criterion.criteria, newCriterion(type) as LeafCriterion]);
	}
</script>

<div class="rounded border border-input/70 p-1.5" data-testid="criterion-group">
	<div class="flex items-center gap-1.5">
		<span class="text-xs font-medium text-muted-foreground">Any of</span>
		{#if criterion.criteria.length === 0}
			<span class="text-[11px] text-muted-foreground/60">(empty — filters nothing)</span>
		{/if}
		<button
			type="button"
			aria-label="Remove group"
			title="Remove this OR group"
			class="ml-auto text-muted-foreground/70 transition-colors hover:text-destructive"
			onclick={() => onRemove(index)}
		>
			✕
		</button>
	</div>
	<div class="mt-1 space-y-1 pl-3">
		{#each criterion.criteria as member, i (i)}
			<CriterionRow
				criterion={member}
				index={i}
				{target}
				{propertyNames}
				onChange={setMember}
				onRemove={removeMember}
			/>
		{/each}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex w-fit items-center gap-1 text-xs text-info/90 transition-colors hover:text-info"
			>
				<Plus class="h-3 w-3" /> alternative
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="w-52">
				{#each memberTypes as t (t)}
					<DropdownMenu.Item onSelect={() => addMember(t)}>
						{CRITERION_LABELS[t]}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</div>
```

- [ ] **Step 4: Narrow `CriterionRow` to leaves**

In `frontend/src/lib/components/Sidebar/CriterionRow.svelte`, three type references change from `Criterion` to `LeafCriterion` (the component never renders a group — hosts branch first):

1. Import (line ~7): `import { CRITERION_LABELS, type LeafCriterion, type TargetKind } from '$lib/search/types';`
2. Props: `criterion: LeafCriterion;` and `onChange: (index: number, next: LeafCriterion) => void;`
3. The `patch` helper: `function patch(next: Partial<LeafCriterion>): void { onChange(index, { ...criterion, ...next } as LeafCriterion); }`

Then run `grep -n "Criterion" frontend/src/lib/components/Sidebar/CriterionRow.svelte` and convert any remaining `Criterion` TYPE references (not `CRITERION_LABELS`/`CriterionType` value uses) to `LeafCriterion`.

- [ ] **Step 5: Wire the three hosts**

**`ScopeEditor.svelte`** — add imports:

```ts
import type { AnyOfCriterion, Criterion, LeafCriterion } from '$lib/search/types';
import CriterionGroupRow from '../Sidebar/CriterionGroupRow.svelte';
```

(replacing the existing `import type { Criterion }` line), add next to `addCriterion`:

```ts
function addGroup(): void {
	onChange({
		...scope,
		criteria: [...(scope.criteria as Criterion[]), newCriterion('any_of')]
	});
}
```

add a second button after the existing `+ condition` button:

```svelte
<button
	type="button"
	class="text-xs text-info/90 transition-colors hover:text-info"
	onclick={addGroup}>+ OR group</button
>
```

and replace the criteria `{#each}` block with:

```svelte
{#each scope.criteria as criterion, i (i)}
	{#if (criterion as Criterion).type === 'any_of'}
		<CriterionGroupRow
			criterion={criterion as AnyOfCriterion}
			index={i}
			target="element"
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{:else}
		<CriterionRow
			criterion={criterion as LeafCriterion}
			index={i}
			target="element"
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{/if}
{/each}
```

**`FilterStepRow.svelte`** — same three edits, with `propertyNames` forwarded: imports as above; `addGroup`:

```ts
function addGroup(): void {
	onChange(index, {
		...step,
		criteria: [...(step.criteria as Criterion[]), newCriterion('any_of')]
	});
}
```

the `{#each step.criteria}` block becomes:

```svelte
{#each step.criteria as criterion, i (i)}
	{#if (criterion as Criterion).type === 'any_of'}
		<CriterionGroupRow
			criterion={criterion as AnyOfCriterion}
			index={i}
			target="element"
			{propertyNames}
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{:else}
		<CriterionRow
			criterion={criterion as LeafCriterion}
			index={i}
			target="element"
			{propertyNames}
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{/if}
{/each}
```

and the same `+ OR group` button goes right after the existing `+ condition` button.

**`AdvancedSearchDialog.svelte`** — the add-criterion dropdown already lists `availableCriterionTypes()`, which now includes `any_of` (labelled "Any of") — that IS this host's add-group affordance; no new button. Edits:

1. Imports: add `CriterionGroupRow` and widen the type import:

```ts
import {
	CRITERION_LABELS,
	type AnyOfCriterion,
	type Criterion,
	type LeafCriterion,
	type SearchResultItem
} from '$lib/search/types';
import CriterionGroupRow from './CriterionGroupRow.svelte';
```

2. Recurse the regex-validity gate (replace the `hasInvalidRegex` derived):

```ts
const leafInvalidRegex = (c: LeafCriterion): boolean =>
	(c.type === 'property' || c.type === 'name_id') &&
	c.op === 'matches' &&
	!isValidRegex(c.value);
const hasInvalidRegex = $derived(
	criteria.some((c) => (c.type === 'any_of' ? c.criteria.some(leafInvalidRegex) : leafInvalidRegex(c)))
);
```

3. Branch the criteria loop:

```svelte
{#each criteria as criterion, index (index)}
	{#if criterion.type === 'any_of'}
		<CriterionGroupRow
			criterion={criterion as AnyOfCriterion}
			{index}
			{target}
			onChange={(i: number, next: Criterion) => updateSearchCriterion(i, next)}
			onRemove={(i: number) => removeSearchCriterion(i)}
		/>
	{:else}
		<CriterionRow
			criterion={criterion as LeafCriterion}
			{index}
			{target}
			onChange={(i: number, next: Criterion) => updateSearchCriterion(i, next)}
			onRemove={(i: number) => removeSearchCriterion(i)}
		/>
	{/if}
{/each}
```

- [ ] **Step 6: Run the new tests, then the full frontend suite + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- criterion-group scope-editor-group'`
Expected: PASS.

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` and `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: all tests pass; svelte-check clean. If `check` flags a `Criterion`/`LeafCriterion` mismatch in a file this plan didn't list, fix it the same way (leaf-only context → `LeafCriterion`, mixed list → `Criterion`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/Sidebar/ frontend/src/lib/components/Navigation/
git commit -m "feat(frontend): OR-group editing in search, navigation, and table criteria editors"
```

---

### Task 6: Full verification sweep

**Files:** none new — this is the gate.

- [ ] **Step 1: Full Python suite**

Run: `pixi run core-test`
Expected: all pass.

- [ ] **Step 2: Full lint/typecheck (ruff + mypy + pyright + frontend)**

Run: `pixi run dr-tidy`
Expected: clean. If ruff reformats anything, re-run tests, then `git add` the formatting.

- [ ] **Step 3: Full frontend suite + check (again, post-tidy)**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` and `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: clean.

- [ ] **Step 4: Commit any tidy fallout**

```bash
git status --short
# only if dr-tidy changed files:
git add -A && git commit -m "style: dr-tidy pass for the any_of criteria groups feature"
```
