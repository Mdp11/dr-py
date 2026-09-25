# Navigation "Go to property" step + "Return elements from step" field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third navigation step kind — "Go to property" (hop through element-reference properties) — and turn the table editors' numeric `step` field into a constrained "Return elements from step" field with an "End of chain" placeholder.

**Architecture:** The step kind is added to the canonical Pydantic schema (`core/navigation/schema.py`) and the pure evaluator (`core/navigation/evaluate.py`); a property step adds one chain column exactly like a relationship step, so `step_types`, set-operand `step_index` math, table evaluation, FeedsChip labels and results headers all follow automatically once `step_types`/`chainColumns` include it. The frontend mirrors the type, adds a `PropertyStepRow` editor with the same property autocompletion as "Keep only", and blocks chain continuation in the UI after a non-element property. Evaluation is graceful (never raises on odd data): a chain that can't hop is pruned.

**Tech Stack:** Python 3.14 (pyright floor 3.10) + Pydantic v2; SvelteKit 5 (runes) + vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-navigation-property-step-and-step-field-design.md`

## Global Constraints

- Everything runs through pixi. Backend tests: `pixi run -e core-dev pytest <path> -v`. Frontend commands MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run <pattern>'`, `... npm run check`.
- Lint gates: `pixi run lint-core` (ruff+mypy+pyright must all pass); frontend `npm run lint` / `npm run check`.
- Python: don't use stdlib features newer than 3.10 (pyright floor).
- The schema field is **`property_name`** (never `property` — builtin shadowing) in both Python and TypeScript.
- Chain convention: chain column 0 = start; **relationship AND property steps each add one column; filter steps add none**. `step_types` has one entry per added column, in step order.
- Preserve the repo's dense docstring/comment style: docstrings explain *why* invariants exist. Every new public function gets one.
- Work on branch `feature/navigation-property-step` (create from `main` if it doesn't exist yet: `git checkout -b feature/navigation-property-step`).
- UI copy (exact strings): label **`Return elements from step`**; input placeholder **`End of chain`**; dead-end notice **`not an element property — navigation ends here`**; blocked-add hint **`Navigation is blocked above — remove or change the non-element property step to continue.`**; add-button **`+ Go to property…`**; insert-zone button **`+ property`**.

---

### Task 1: Backend schema — `PropertyStep`

**Files:**
- Modify: `src/data_rover/core/navigation/schema.py`
- Test: `tests/navigation/test_schema.py`

**Interfaces:**
- Produces: `PropertyStep(kind="property", property_name: str, comment: Optional[str])`, member of `StepItem` (discriminated on `kind`). Importable as `from data_rover.core.navigation.schema import PropertyStep`.

- [ ] **Step 1: Write the failing tests** — append to `tests/navigation/test_schema.py`, following the file's existing conventions (it already tests step kinds, MAX_STEPS, and v2 branching rejection — read it first and reuse its helpers if any):

```python
def test_property_step_parses_and_roundtrips() -> None:
    doc = {
        "kind": "path",
        "start": {"kind": "scope"},
        "steps": [{"kind": "property", "property_name": "owner", "comment": "why"}],
    }
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    step = nav.steps[0]
    assert step.kind == "property"
    assert step.property_name == "owner"
    assert step.comment == "why"
    dumped = NAVIGATION_ADAPTER.dump_python(nav)
    assert dumped["steps"][0]["kind"] == "property"


def test_property_step_requires_property_name() -> None:
    doc = {"kind": "path", "start": {"kind": "scope"}, "steps": [{"kind": "property"}]}
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(doc)


def test_max_steps_counts_property_steps() -> None:
    steps = [{"kind": "property", "property_name": "p"}] * (MAX_STEPS + 1)
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(
            {"kind": "path", "start": {"kind": "scope"}, "steps": steps}
        )
```

(Import `MAX_STEPS`, `NAVIGATION_ADAPTER`, `pydantic.ValidationError` per the file's existing imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_schema.py -v -k property`
Expected: FAIL — pydantic discriminator error: `'property'` is not a valid `kind`.

- [ ] **Step 3: Implement** — in `src/data_rover/core/navigation/schema.py`, after `FilterStep`:

```python
class PropertyStep(BaseModel):
    """A hop through an element-reference property: for each frontier element,
    follow `property_name`'s value(s) — element ids — to the referenced
    element(s). Adds ONE chain column, exactly like a RelationshipStep.

    Per element, the hop applies only when the element's EFFECTIVE property
    def exists and its datatype is an element type; otherwise that chain is
    pruned — graceful, mirroring FilterStep's existence-gating, so the engine
    never raises on odd models. Dangling ids are skipped."""

    kind: Literal["property"] = "property"
    property_name: str
    #: free-form user note explaining the step's intent (UI-only; the
    #: evaluator ignores it).
    comment: Optional[str] = None
```

Then:
- `StepItem = Annotated[Union[RelationshipStep, FilterStep, PropertyStep], Field(discriminator="kind")]`
- Add `PropertyStep.model_rebuild()` next to the other rebuild calls.
- Update the module docstring's CHAIN CONVENTION bullet: "…a path with N *relationship or property* steps yields chains of length N+1 — a `FilterStep` prunes the frontier in place and adds no column."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/ -v`
Expected: all PASS (new + existing).

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core
git add src/data_rover/core/navigation/schema.py tests/navigation/test_schema.py
git commit -m "feat(navigation): add PropertyStep to the step-kind schema"
```

---

### Task 2: Backend evaluator — property hops

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py`
- Test: `tests/navigation/test_evaluate_path.py`, `tests/navigation/test_evaluate_sets.py`

**Interfaces:**
- Consumes: `PropertyStep` from Task 1; `Metamodel.effective_element_properties(type_name) -> list[PropertyDef]`, `Metamodel.is_element_type(name) -> bool` (existing cached lookups in `core/metamodel/schema.py`).
- Produces: `evaluate()` handles property steps; `ChainResult.step_types` lists, per chain column in step order, the relationship type (relationship step) or the property name (property step).

- [ ] **Step 1: Write the failing tests.** In `tests/navigation/test_evaluate_path.py`, add a self-contained fixture (do NOT touch `_mm`/`_fixture` — existing tests depend on them) plus tests:

```python
def _ref_mm() -> Metamodel:
    # `building`/`peers` are ELEMENT-REFERENCE properties (datatype names an
    # element type; values are element ids). `tags` is a plain string.
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(
                name="Sensor",
                properties=[
                    PropertyDef(name="building", datatype="Building"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                    PropertyDef(name="peers", datatype="Sensor", multiplicity="0..*"),
                ],
            ),
            ElementType(name="SmartSensor", extends="Sensor"),
        ],
        relationships=[
            RelationshipType(name="Measures", source="Sensor", target="Building"),
        ],
    )


def _prop(name: str) -> dict:
    return {"kind": "property", "property_name": name}


def _ref_fixture() -> tuple[Model, dict[str, str]]:
    model = Model(_ref_mm())
    ids: dict[str, str] = {}
    for key, type_name in [
        ("b1", "Building"), ("b2", "Building"),
        ("s1", "Sensor"), ("s2", "Sensor"), ("smart", "SmartSensor"),
    ]:
        ids[key] = model.create_element(type_name).id
    model.set_property(model.elements[ids["s1"]], "building", ids["b1"])
    model.set_property(model.elements[ids["s1"]], "peers", [ids["s2"], ids["smart"]])
    model.set_property(model.elements[ids["s1"]], "tags", ["hot"])
    model.set_property(model.elements[ids["smart"]], "building", ids["b2"])
    # s2 carries no properties at all.
    return model, ids


def _prop_path(**overrides):
    doc = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Sensor"]},
        "steps": [_prop("building")],
    }
    doc.update(overrides)
    return NAVIGATION_ADAPTER.validate_python(doc)


def test_property_hop_follows_single_reference() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path())
    assert (ids["s1"], ids["b1"]) in result.chains
    assert result.step_types == ["building"]


def test_property_hop_follows_list_reference() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path(steps=[_prop("peers")]))
    assert (ids["s1"], ids["s2"]) in result.chains
    assert (ids["s1"], ids["smart"]) in result.chains


def test_property_hop_resolves_inherited_property() -> None:
    # SmartSensor inherits `building` from Sensor (effective-property lookup).
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path())
    assert (ids["smart"], ids["b2"]) in result.chains


def test_property_hop_prunes_absent_property() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path())
    assert not any(chain[0] == ids["s2"] for chain in result.chains)


def test_property_hop_prunes_non_element_datatype() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path(steps=[_prop("tags")]))
    assert result.chains == []
    assert result.step_types == ["tags"]


def test_property_hop_skips_dangling_reference() -> None:
    model, ids = _ref_fixture()
    model.set_property(model.elements[ids["s2"]], "building", "no-such-id")
    result = evaluate(model.metamodel, model, _prop_path())
    assert not any(chain[0] == ids["s2"] for chain in result.chains)


def test_property_hop_honors_exclude_visited() -> None:
    model, ids = _ref_fixture()
    model.set_property(model.elements[ids["s2"]], "peers", [ids["s2"]])
    nav = _prop_path(steps=[_prop("peers")])
    assert (ids["s2"], ids["s2"]) not in evaluate(model.metamodel, model, nav).chains
    nav = _prop_path(steps=[_prop("peers")], exclude_visited=False)
    assert (ids["s2"], ids["s2"]) in evaluate(model.metamodel, model, nav).chains


def test_mixed_relationship_and_property_chain() -> None:
    model, ids = _ref_fixture()
    model.connect("Measures", ids["s2"], ids["b1"])
    nav = _prop_path(
        start={"kind": "scope", "types": ["Sensor"]},
        steps=[_prop("peers"), {"kind": "relationship", "relationship_type": "Measures"}],
    )
    result = evaluate(model.metamodel, model, nav)
    assert (ids["s1"], ids["s2"], ids["b1"]) in result.chains
    assert result.step_types == ["peers", "Measures"]
```

In `tests/navigation/test_evaluate_sets.py`, add one test (reuse that file's fixture style — read it first; if its metamodel lacks reference properties, build the operand's inner path with `_ref_mm`-style local fixtures as above):

```python
def test_operand_step_index_addresses_property_step_column() -> None:
    model, ids = _ref_fixture()
    expr = NAVIGATION_ADAPTER.validate_python({
        "kind": "set_op",
        "op": "union",
        "operands": [{
            "definition": {
                "kind": "path",
                "start": {"kind": "scope", "types": ["Sensor"]},
                "steps": [{"kind": "property", "property_name": "building"}],
            },
            "step_index": 1,
        }],
    })
    result = evaluate(model.metamodel, model, expr)
    assert {c[0] for c in result.chains} == {ids["b1"], ids["b2"]}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_evaluate_path.py tests/navigation/test_evaluate_sets.py -v -k property`
Expected: FAIL — the evaluator treats a `PropertyStep` as a `RelationshipStep` (AttributeError) or skips it; `step_types` assertions fail.

- [ ] **Step 3: Implement** in `src/data_rover/core/navigation/evaluate.py`:

Import `PropertyStep` from `.schema`. Add after `_hop`:

```python
def _hop_property(
    metamodel: Metamodel,
    model: Model,
    element_id: str,
    step: PropertyStep,
    budget: _Budget,
) -> list[str]:
    """Continuations of a property hop: the element's `property_name` value(s)
    resolved to existing elements. Gated on the element's EFFECTIVE property
    def being element-typed — a string that merely looks like an id must not
    navigate. Absent/non-reference/dangling cases prune the chain silently
    (never raise): navigation stays inspectable on odd models, mirroring
    FilterStep's existence-gating."""
    element = model.elements[element_id]
    prop = next(
        (
            p
            for p in metamodel.effective_element_properties(element.type_name)
            if p.name == step.property_name
        ),
        None,
    )
    if prop is None or not metamodel.is_element_type(prop.datatype):
        return []
    value = element.properties.get(step.property_name)
    if value is None:
        return []
    candidates = value if isinstance(value, list) else [value]
    if not budget.spend(len(candidates)):
        return []
    nxt = {
        item for item in candidates if isinstance(item, str) and item in model.elements
    }
    return sorted(nxt)
```

In `_walk`, replace the line `nxt = _hop(metamodel, model, current, step, budget)` with a dispatch (the `FilterStep` branch above it is unchanged):

```python
    if isinstance(step, RelationshipStep):
        nxt = _hop(metamodel, model, current, step, budget)
    else:
        nxt = _hop_property(metamodel, model, current, step, budget)
```

In `evaluate`, replace the `step_types=` comprehension with a single ordered pass (a property step contributes its property name — this keeps `_operand_members`' `n_steps = len(inner.step_types)` and the table evaluator's chain-length math correct with zero further changes):

```python
        step_types=[
            s.relationship_type if isinstance(s, RelationshipStep) else s.property_name
            for s in defn.steps
            if not isinstance(s, FilterStep)
        ],
```

Update `_walk`'s docstring: "A RelationshipStep or PropertyStep extends the chain by one hop (deterministic, sorted-id); a FilterStep …". Update the module docstring's "hop" bullet to mention property hops go through `element.properties`, not adjacency.

- [ ] **Step 4: Run the full backend suite**

Run: `pixi run test-core`
Expected: all PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-core
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_evaluate_path.py tests/navigation/test_evaluate_sets.py
git commit -m "feat(navigation): evaluate property-hop steps"
```

---

### Task 3: Backend coverage — property steps through tables and the API route

**Files:**
- Test: `tests/table/test_cells.py` (or `tests/table/test_build_rows.py` — pick whichever file's existing helpers make the test shortest; read both first)
- Test: `tests/api/test_artifacts_routes.py`

No production code — Tasks 1–2 made tables and `/navigations/evaluate` work by construction; this task pins that with tests.

**Interfaces:**
- Consumes: `PropertyStep` (Task 1), evaluator behavior (Task 2); existing table schema (`NavigationColumn.step_index`, `core/table/schema.py`) and route `POST /navigations/evaluate` (`src/data_rover/api/routes/artifacts.py`).

- [ ] **Step 1: Write the failing-or-passing tests** (they should pass immediately if Tasks 1–2 are correct — the point is regression coverage; if they fail, that's a real bug to fix in the Task 2 code):

Table test — follow the target file's existing fixture conventions for building a `TableDefinition` (metamodel/model builders, evaluate/build_rows entry point). The scenario, exactly:
- Metamodel: `Building` (property `name: string`), `Sensor` (property `building` with `datatype="Building"`).
- Model: one Building `b1`, one Sensor `s1` with `properties["building"] = <b1.id>`.
- Table: row source = scope over `Sensor`; one navigation column whose inline definition is `{"kind": "path", "start": {"kind": "row"}, "steps": [{"kind": "property", "property_name": "building"}], "exclude_visited": True}` with `step_index=None`.
- Assert: the single row's navigation cell resolves to `b1` (default `step_index=None` → last step, valid because the property step added a chain column).

API route test — in `tests/api/test_artifacts_routes.py`, following its existing `POST /navigations/evaluate` tests (client fixture, seeded project, auth headers): POST a definition containing a property step against seeded content with one element-reference property, and assert `step_types == ["<property name>"]` and the expected chain ids come back. If the conftest's seeded model has no reference property, upload/construct one the same way that file's other tests arrange content.

- [ ] **Step 2: Run the tests**

Run: `pixi run -e core-dev pytest tests/table -v -k property` and `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -v -k property`
Expected: PASS. (A failure means Task 2's implementation has a real integration bug — fix it there, don't adjust the assertion.)

- [ ] **Step 3: Commit**

```bash
git add tests/table tests/api/test_artifacts_routes.py
git commit -m "test(navigation): cover property steps through tables and the evaluate route"
```

---

### Task 4: Frontend types + pure tree helpers

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (navigation section, ~lines 373–400)
- Modify: `frontend/src/lib/navigation/tree.ts` (`chainColumns`, `nodeLabel`, `isRunnable`, `precedingTargetTypes`)
- Test: `frontend/src/lib/navigation/__tests__/tree.test.ts`

**Interfaces:**
- Produces:
  - `NavPropertyStep { kind: 'property'; property_name: string; comment?: string | null }`, member of `NavStepItem` (in `$lib/api/types`).
  - `chainColumns`: a property step adds a column `{ index, label: property_name || 'unset step', sub: 'property' }`.
  - `isRunnable`: false while any property step has an empty `property_name`.
  - `precedingTargetTypes`: scanning backward, a property step yields `[]` ("any type" — the pure, metamodel-free fallback; Task 5 adds the precise version).

- [ ] **Step 1: Write the failing tests** — append to `frontend/src/lib/navigation/__tests__/tree.test.ts` (reuse its existing path-builder helpers; the shapes below show intent):

```ts
const propStep = (name: string): NavStepItem => ({ kind: 'property', property_name: name });

test('chainColumns counts property steps as columns', () => {
	const node: PathNavigation = {
		...emptyPath(),
		start: { kind: 'scope', types: ['Sensor'], criteria: [] },
		steps: [propStep('building'), { kind: 'filter', criteria: [] }, propStep('')]
	};
	const cols = chainColumns(node);
	expect(cols.map((c) => c.label)).toEqual(['Start', 'building', 'unset step']);
	expect(cols[1].sub).toBe('property');
	expect(cols.map((c) => c.index)).toEqual([0, 1, 2]);
});

test('isRunnable requires property steps to have a property_name', () => {
	const node = { ...emptyPath(), start: { kind: 'scope', types: ['Sensor'], criteria: [] } };
	expect(isRunnable({ ...node, steps: [propStep('')] })).toBe(false);
	expect(isRunnable({ ...node, steps: [propStep('building')] })).toBe(true);
});

test('nodeLabel includes property hops', () => {
	const node = {
		...emptyPath(),
		start: { kind: 'scope', types: ['Sensor'], criteria: [] },
		steps: [propStep('building')]
	};
	expect(nodeLabel(node)).toBe('Sensor → .building');
});

test('precedingTargetTypes falls back to any-type past a property step', () => {
	const node = {
		...emptyPath(),
		start: { kind: 'scope', types: ['Sensor'], criteria: [] },
		steps: [propStep('building'), { kind: 'filter', criteria: [] }]
	};
	expect(precedingTargetTypes(node, 1)).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/navigation'`
Expected: FAIL (TS error on `kind: 'property'` and/or assertion failures).

- [ ] **Step 3: Implement.**

`types.ts` — after `NavFilterStep`:

```ts
export interface NavPropertyStep {
	kind: 'property';
	property_name: string;
	/** Free-form user note explaining the step's intent (evaluator ignores it). */
	comment?: string | null;
}

export type NavStepItem = NavRelationshipStep | NavFilterStep | NavPropertyStep;
```

`tree.ts`:

- `chainColumns` — replace the step loop body:

```ts
	for (const step of node.steps) {
		if (step.kind === 'filter') continue;
		if (step.kind === 'relationship') {
			cols.push({
				index: cols.length,
				label: step.relationship_type || 'unset step',
				sub: step.target_types.length > 0 ? [...step.target_types].sort().join(', ') : undefined
			});
		} else {
			// A property hop advances the chain exactly like a relationship hop.
			// `sub: 'property'` (not a type list): the pure helper has no
			// metamodel to resolve the datatype with.
			cols.push({ index: cols.length, label: step.property_name || 'unset step', sub: 'property' });
		}
	}
```

Update the `ChainColumn` doc comment: "each RELATIONSHIP or PROPERTY step adds one column; filter steps add none".

- `nodeLabel` — replace the `hops` computation:

```ts
	const hops = defn.steps
		.filter((s) => s.kind !== 'filter')
		.map((s) => (s.kind === 'relationship' ? s.relationship_type || '?' : `.${s.property_name || '?'}`));
```

- `isRunnable` — replace the relationship-only guard:

```ts
	if (
		defn.steps.some(
			(s) =>
				(s.kind === 'relationship' && !s.relationship_type) ||
				(s.kind === 'property' && !s.property_name)
		)
	)
		return false;
```

- `precedingTargetTypes` — in the backward scan, before the relationship check:

```ts
		if (step.kind === 'property') return []; // metamodel-free fallback: "any type" (frontierTypesAt is the precise version)
```

Extend its doc comment accordingly.

- [ ] **Step 4: Run tests + typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/navigation && npm run check'`
Expected: tests PASS; svelte-check may surface exhaustiveness errors in components that switch on `NavStepItem` (e.g. `PathCard.svelte`'s `{:else}` still renders `FilterStepRow` for property steps — TS may or may not flag this depending on the prop cast). Fix ONLY type errors here minimally (e.g. widen a cast); Task 6 does the real UI. `npm run check` must exit clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/navigation/tree.ts frontend/src/lib/navigation/__tests__/tree.test.ts
git commit -m "feat(frontend): NavPropertyStep type + property-aware tree helpers"
```

---

### Task 5: Metamodel-aware frontier types

**Files:**
- Modify: `frontend/src/lib/metamodel/helpers.ts`
- Test: the existing helpers test file under `frontend/src/lib/metamodel/__tests__/` (find it; create `helpers.test.ts` there only if none exists)

**Interfaces:**
- Consumes: `NavPropertyStep`/`NavStepItem` (Task 4); existing `effectiveProperties`, `isSubtype` in the same file.
- Produces (both exported from `$lib/metamodel/helpers`):
  - `propertyStepTargetTypes(mm: Metamodel, typeNames: string[], propName: string): string[]` — sorted element-type datatypes `propName` resolves to across `typeNames`' reachable types (themselves + subtypes; `[]` = every type). **Empty result ⇒ the property is not an element reference anywhere reachable ⇒ the chain is blocked past such a step.**
  - `frontierTypesAt(mm: Metamodel, node: PathNavigation, index: number): string[]` — the frontier types flowing INTO `steps[index]` (metamodel-aware upgrade of `precedingTargetTypes`).

- [ ] **Step 1: Write the failing tests** (build a small `Metamodel` literal like the file's other tests; shape: `Building`; `Sensor` with `building: Building`, `tags: string`; `SmartSensor extends Sensor`):

```ts
test('propertyStepTargetTypes resolves element-typed datatypes across subtypes', () => {
	expect(propertyStepTargetTypes(mm, ['Sensor'], 'building')).toEqual(['Building']);
	expect(propertyStepTargetTypes(mm, ['SmartSensor'], 'building')).toEqual(['Building']); // inherited
	expect(propertyStepTargetTypes(mm, ['Sensor'], 'tags')).toEqual([]); // string → blocked
	expect(propertyStepTargetTypes(mm, ['Sensor'], 'nope')).toEqual([]); // undeclared → blocked
	expect(propertyStepTargetTypes(mm, [], 'building')).toEqual(['Building']); // [] = any type
});

test('frontierTypesAt walks relationship and property steps forward', () => {
	const node: PathNavigation = {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: ['Sensor'], criteria: [] },
		steps: [
			{ kind: 'property', property_name: 'building' },
			{ kind: 'filter', criteria: [] },
			{ kind: 'property', property_name: 'tags' }
		],
		exclude_visited: true
	};
	expect(frontierTypesAt(mm, node, 0)).toEqual(['Sensor']);
	expect(frontierTypesAt(mm, node, 1)).toEqual(['Building']); // after the property hop
	expect(frontierTypesAt(mm, node, 2)).toEqual(['Building']); // filter changes nothing
	expect(frontierTypesAt(mm, node, 3)).toEqual([]); // past a dead-end property: any
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/metamodel'`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement** — append to `helpers.ts` (import `PathNavigation` from `$lib/api/types`):

```ts
/**
 * Element-type datatypes `propName` resolves to across `typeNames`' reachable
 * types (themselves + all subtypes; `[]` = every element type), sorted.
 * Scans EVERY declaration of the name — like {@link propertyDeclaredMany},
 * NOT {@link effectivePropertiesForTypes}, whose first-wins dedupe would lose
 * datatype variance across same-named properties. An empty result means the
 * property is nowhere an element reference: a navigation "Go to property"
 * step over it is a dead end (the chain cannot continue).
 */
export function propertyStepTargetTypes(
	mm: Metamodel,
	typeNames: string[],
	propName: string
): string[] {
	const roots = typeNames.length === 0 ? mm.elements.map((e) => e.name) : typeNames;
	const out = new Set<string>();
	for (const t of mm.elements) {
		if (!roots.some((r) => isSubtype(mm, t.name, r))) continue;
		for (const p of effectiveProperties(mm, t.name)) {
			if (p.name === propName && mm.elements.some((e) => e.name === p.datatype)) {
				out.add(p.datatype);
			}
		}
	}
	return [...out].sort();
}

/**
 * The frontier types flowing INTO `steps[index]` — the metamodel-aware
 * upgrade of `precedingTargetTypes` (navigation/tree.ts): a forward walk that
 * resolves each property step's outgoing types via
 * {@link propertyStepTargetTypes} instead of giving up to "any type".
 * `[]` still means "any type" (combine/element starts, or an unresolvable
 * property step). Filter steps never change the frontier.
 */
export function frontierTypesAt(mm: Metamodel, node: PathNavigation, index: number): string[] {
	let frontier: string[] = node.start.kind === 'scope' ? node.start.types : [];
	for (let i = 0; i < Math.min(index, node.steps.length); i++) {
		const step = node.steps[i];
		if (step.kind === 'relationship') frontier = step.target_types;
		else if (step.kind === 'property') {
			frontier = step.property_name
				? propertyStepTargetTypes(mm, frontier, step.property_name)
				: [];
		}
	}
	return frontier;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/metamodel && npm run check'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel
git commit -m "feat(frontend): metamodel-aware navigation frontier types"
```

---

### Task 6: "Go to property" step UI

**Files:**
- Create: `frontend/src/lib/components/Navigation/PropertyStepRow.svelte`
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte`
- Test: `frontend/src/lib/components/Navigation/__tests__/property-step-row.test.ts` (new), plus additions to `__tests__/path-card.test.ts`

**Interfaces:**
- Consumes: `NavPropertyStep` (Task 4), `frontierTypesAt`/`propertyStepTargetTypes` (Task 5), `chainColumns` (Task 4), `PropertyItem`/`resolvePropertyKind` (`$lib/search/property-ops`), the property picker component `CriterionRow` uses (read `frontend/src/lib/components/Sidebar/CriterionRow.svelte` first and reuse the same `PropertyPicker` component with the same props).
- Produces: `PropertyStepRow.svelte` with props `{ step: NavPropertyStep; index: number; column: number; items: PropertyItem[]; deadEnd: boolean; onChange: (index, next: NavPropertyStep) => void; onRemove: (index) => void }`.

- [ ] **Step 1: Read the neighbors.** Read `RelationshipStepRow.svelte`, `FilterStepRow.svelte`, `Sidebar/CriterionRow.svelte` (how `PropertyPicker` is instantiated), and `__tests__/step-editor.test.ts` + `__tests__/path-card.test.ts` (test harness: how they mount PathCard, seed the metamodel store, and query steps).

- [ ] **Step 2: Write the failing tests.**

`property-step-row.test.ts` (mirror `step-editor.test.ts`'s mounting style):
- renders the sentence text `Go to property` and a `ChainBadge` with the given `column`;
- picking a property from the autocompletion calls `onChange(index, { …step, property_name: '<picked>' })`;
- `deadEnd: true` renders the notice text `not an element property — navigation ends here`; `deadEnd: false` does not;
- the ✕ button calls `onRemove(index)`.

`path-card.test.ts` additions:
- the trailing buttons include `+ Go to property…`; clicking appends `{ kind: 'property', property_name: '' }` to the draft;
- the hover insert zone includes a `+ property` button;
- with a draft whose steps are `[{kind:'property', property_name:'<non-element prop>'}]` (metamodel fixture: the property's datatype is `string`), the trailing add buttons are gone and the hint `Navigation is blocked above — remove or change the non-element property step to continue.` is rendered;
- with an element-typed property step, the add buttons remain.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/components/Navigation'`
Expected: FAIL (component missing; buttons missing).

- [ ] **Step 4: Implement `PropertyStepRow.svelte`.** Structure it as a hybrid of `RelationshipStepRow` (it advances the chain → render `<ChainBadge value={column} />`) and `FilterStepRow` (comment affordance — copy the `editingComment` block verbatim, adjusting the type). Sentence: `<span class="text-muted-foreground">Go to property</span>` followed by the property picker (same component + props as `CriterionRow`'s property picker, fed from `items`), then the selected item's datatype as a muted chip when known. Below, when `deadEnd`:

```svelte
{#if deadEnd}
	<div data-testid="property-dead-end" class="pl-7 text-[11px] text-warning">
		not an element property — navigation ends here
	</div>
{/if}
```

Use `data-testid="property-step"` on the row root.

- [ ] **Step 5: Wire `PathCard.svelte`.**

- Imports: `PropertyStepRow`, `frontierTypesAt`, `propertyStepTargetTypes`, `NavPropertyStep`.
- Frontier helpers (replace the bodies of the two existing functions — keep `precedingTargetTypes` fallback when `mm` is null — and add items/blocked):

```ts
	function frontierFor(i: number): string[] {
		return mm ? frontierTypesAt(mm, node, i) : precedingTargetTypes(node, i);
	}
	function sourceTypesFor(i: number): string[] {
		return frontierFor(i);
	}
	function propertyNamesFor(i: number): string[] {
		if (!mm) return [];
		return effectivePropertiesForTypes(mm, frontierFor(i)).map((p) => p.name);
	}
	function propertyItemsForStep(i: number): PropertyItem[] {
		if (!mm) return [];
		return effectivePropertiesForTypes(mm, frontierFor(i)).map((p) => ({
			name: p.name,
			datatype: p.datatype
		}));
	}
	// First step index whose configured property can never continue the chain
	// (not an element reference anywhere reachable) — everything past it is
	// unreachable, so the add/insert affordances close down there.
	const blockedAt = $derived.by((): number | null => {
		if (!mm) return null;
		for (let i = 0; i < node.steps.length; i++) {
			const s = node.steps[i];
			if (s.kind !== 'property' || !s.property_name) continue;
			if (propertyStepTargetTypes(mm, frontierTypesAt(mm, node, i), s.property_name).length === 0)
				return i;
		}
		return null;
	});
```

- `columnFor` counts property steps too: `if (node.steps[j].kind !== 'filter') n++`.
- `emptyPropertyStep(): NavPropertyStep { return { kind: 'property', property_name: '' }; }` and `addPropertyStep()` via `insertStep(node.steps.length, emptyPropertyStep())`.
- Step rendering: add the `property` branch dispatching to `PropertyStepRow` with `column={columnFor(i)}`, `items={propertyItemsForStep(i)}`, `deadEnd={blockedAt === i}`; wrap each step row so rows past the block are muted: `<div class:opacity-50={blockedAt !== null && i > blockedAt}>…</div>`.
- Insert zones: render the zone only when `blockedAt === null || i <= blockedAt`; add the third button `+ property` (`aria-label="Insert property step here"`, `title="Insert a 'Go to property' step here"`, onclick `insertStep(i, emptyPropertyStep())`).
- Trailing buttons: when `blockedAt !== null`, replace all three with the hint `<span class="text-[11px] text-warning">Navigation is blocked above — remove or change the non-element property step to continue.</span>`; otherwise render the existing two plus `+ Go to property…` (onclick `addPropertyStep`).

Also check `navigation-editor.svelte.ts`'s draft normalization (`ensureEmbeddedDraft` / any `normalizeDefinition` it calls): if it switches on step kinds, let `property` steps pass through unchanged; if it's shape-agnostic, no change.

- [ ] **Step 6: Run the Navigation component tests, then the whole frontend suite + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/components/Navigation && npm test -- --run && npm run check'`
Expected: all PASS, check clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/Navigation frontend/src/lib/state/navigation-editor.svelte.ts
git commit -m "feat(frontend): 'Go to property' navigation step editor with dead-end blocking"
```

---

### Task 7: Table editors — rename, placeholder, constraint

**Files:**
- Modify: `frontend/src/lib/components/Table/NavigationColumnEditor.svelte` (label ~line 305, `setStepIndex` ~line 198)
- Modify: `frontend/src/lib/components/Table/RowSourceEditor.svelte` (label ~line 161, `onStepIndexChange` ~line 96)
- Test: the existing Table component test directory (`frontend/src/lib/components/Table/__tests__/` — find the files covering these two editors; create `step-index-field.test.ts` there if none do)

**Interfaces:**
- Consumes: `chainColumns` (Task 4; property steps count), `api.getArtifact` (`$lib/api/artifacts`, already imported in NavigationColumnEditor), `NavigationDefinition`.
- Produces: in both editors — label text `Return elements from step`; `placeholder="End of chain"`; `min="0"`/`max` bound to the effective chain; handler clamps into `[0, max]`; stored out-of-range values re-clamped when the chain shrinks.

Backend ground truth for the max: `core/table/evaluate.py::_check_step_index` accepts non-negative `idx < chain_len` where `chain_len` = chain-column count, so **maxStepIndex = chainColumns(path).length − 1**; a `set_op` definition yields single-element chains → max 0.

- [ ] **Step 1: Write the failing tests** (per editor; mirror the harness of the existing Table tests — MSW is available for the artifact fetch):
- the label reads `Return elements from step` (the old bare `step` label is gone);
- the input has `placeholder="End of chain"`, `min="0"`;
- with an inline path definition containing 2 chain-advancing steps, the input has `max="2"`; typing `9` emits `step_index: 2`; clearing emits `null`;
- with a saved-ref navigation, after the mocked `GET` artifact resolves (payload: a path with 1 relationship step), the input has `max="1"`;
- when the definition shrinks below a stored `step_index` (rerender with fewer steps / swapped column), the editor emits the clamped value.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/components/Table'`
Expected: FAIL.

- [ ] **Step 3: Implement — `NavigationColumnEditor.svelte`.**

Script additions (imports: `chainColumns` from `$lib/navigation/tree`):

```ts
	// The saved-ref navigation's payload, fetched to size the step field.
	// $state.raw for the same DataCloneError reason as lastInline.
	let refPayload = $state.raw<NavigationDefinition | null>(null);
	let refLoadedFor: string | null = null;
	$effect(() => {
		const ref = !inline ? (column.navigation.ref ?? null) : null;
		if (!ref) {
			refPayload = null;
			refLoadedFor = null;
			return;
		}
		if (refLoadedFor === ref) return;
		refLoadedFor = ref;
		api
			.getArtifact(ref)
			.then((a) => {
				if (refLoadedFor === ref) refPayload = a.payload as unknown as NavigationDefinition;
			})
			.catch(() => {
				if (refLoadedFor === ref) refPayload = null; // unknown ref: unconstrained
			});
	});
	const effectiveDefn = $derived(inline ? column.navigation.definition! : refPayload);
	// Backend contract (table/evaluate.py::_check_step_index): valid
	// non-negative indices are 0..chain_len-1; a set_op yields 1-element
	// chains, so its only valid index is 0. null = unknown → unconstrained.
	const maxStepIndex = $derived(
		effectiveDefn == null
			? null
			: effectiveDefn.kind === 'path'
				? chainColumns(effectiveDefn).length - 1
				: 0
	);
```

Replace `setStepIndex`:

```ts
	function setStepIndex(e: Event): void {
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		if (raw === '') {
			onChange({ ...column, step_index: null }); // null = end of chain
			return;
		}
		const n = Math.floor(Number(raw));
		if (!Number.isFinite(n)) return;
		const clamped = Math.max(0, maxStepIndex == null ? n : Math.min(n, maxStepIndex));
		onChange({ ...column, step_index: clamped });
	}
```

Re-clamp on chain shrink (converges: after the clamped write the condition is false):

```ts
	$effect(() => {
		if (maxStepIndex != null && column.step_index != null && column.step_index > maxStepIndex) {
			onChange({ ...column, step_index: maxStepIndex });
		}
	});
```

Markup:

```svelte
			<label class="flex items-center gap-1">
				Return elements from step
				<input
					type="number"
					min="0"
					max={maxStepIndex ?? undefined}
					placeholder="End of chain"
					class="w-24 rounded border border-input bg-card px-1 py-0.5"
					value={column.step_index ?? ''}
					oninput={setStepIndex}
				/>
			</label>
```

(Width bumped `w-12` → `w-24` so the placeholder is legible.)

- [ ] **Step 4: Implement — `RowSourceEditor.svelte`.** Same pattern, adapted: import `* as api from '$lib/api/artifacts'` and `chainColumns`; the ref lives at `rowSource.kind !== 'scope' ? rowSource.navigation.ref : null` and the inline definition at `rowSource.navigation.definition`; the write goes through `apply({ ...rowSource, step_index: … })` and is guarded by `rowSource.kind === 'navigation'` (only that kind renders the field). Same `maxStepIndex` derivation, same clamped `onStepIndexChange`, same re-clamp `$effect` (guarded on `rowSource.kind === 'navigation'`), same markup with label `Return elements from step`, `placeholder="End of chain"`, `min="0"`, `max={maxStepIndex ?? undefined}`, width `w-24`.

- [ ] **Step 5: Run tests + full suite + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run && npm run check'`
Expected: all PASS. If an existing test asserted the old `step` label, update it — the rename is the intended behavior.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Table
git commit -m "feat(frontend): constrained 'Return elements from step' field in table editors"
```

---

### Task 8: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Backend** — `pixi run test-core` → all pass; `pixi run lint-core` → clean; `pixi run lint-backend` → clean (route schemas untouched, but the evaluator feeds them).
- [ ] **Step 2: Frontend** — `pixi run -e frontend bash -c 'cd frontend && npm test -- --run && npm run check && npm run lint'` → all pass/clean.
- [ ] **Step 3: End-to-end sanity of the feature surface** (manual drive, no code): boot backend + frontend if a quick check is feasible; otherwise rely on the component/API coverage above.
- [ ] **Step 4: Report** — summarize test counts and any deviations from this plan.
