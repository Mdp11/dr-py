# Navigation Composition + Step-Model — Backend/Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the navigation core to schema v2 — split each step into a relationship hop or a filter, evaluate the interleaved list, and existence-gate navigation property matching — without touching backend routes or the ref resolver.

**Architecture:** `core/navigation/schema.py` replaces the single `Step` with a discriminated `RelationshipStep | FilterStep` union (`schema_version = 2`). `core/navigation/evaluate.py` walks the interleaved item list: relationship steps extend chains, filter steps prune in place (no chain column), and navigation property criteria require the property to be present. The schema change breaks every step-building test at once, so schema + evaluator + all step-shape test updates land in a single atomic commit (`pixi run test-core` covers `tests/` including `tests/api`).

**Tech Stack:** Python 3.14 runtime (pyright floor 3.10 — import `Self`/`assert_never` from `typing_extensions`, not `typing`), Pydantic v2, pytest via pixi.

## Global Constraints

- Run Python via `pixi run -e core-dev pytest <path> -v`; full core suite via `pixi run test-core`; lint via `pixi run lint-core` and `pixi run lint-backend` (ruff + mypy + pyright — all three must pass).
- `pixi run tidy` must be green before any "done" claim; if it reformats files this branch never touched (pre-existing drift), revert those to keep the diff scoped.
- Commit trailer: every commit ends with a blank line then exactly `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `feat/stage1-navigation` (continue on it; do not branch).
- No schema migration / no v1 dual-read — `schema_version = 2` only.
- `core/search/criteria.py` MUST NOT change (search wire-format parity); the existence gate lives in the navigation evaluator only.
- IDE `<new-diagnostics>` about unresolved imports on `data_rover.*`/pydantic are out-of-env noise; the pixi commands above are the only authoritative gates.

---

### Task 1: Schema v2 step union + evaluator rewrite (atomic core)

**Files:**
- Modify: `src/data_rover/core/navigation/schema.py`
- Modify: `src/data_rover/core/navigation/evaluate.py`
- Modify/Test: `tests/navigation/test_schema.py`
- Modify/Test: `tests/navigation/test_evaluate_path.py`
- Test: `tests/navigation/test_evaluate_sets.py` (verify still green; update step shape only if it builds steps)
- Test: `tests/navigation/test_resolve.py` (verify still green; update step shape only if it builds steps)
- Modify: `tests/api/test_artifacts_routes.py` (step shape at lines ~21, ~166, ~190–191)

**Interfaces:**
- Consumes: `Metamodel.is_relationship_subtype`, `Metamodel.is_element_subtype`, `Metamodel.element_descendants`, `model.indexes.{outgoing_ids,incoming_ids,elements_by_type}`, `core.search.criteria.{match_element, PropertyCriterion, Criterion}` (all unchanged).
- Produces:
  - `RelationshipStep(kind="relationship", relationship_type: str, direction: Literal["out","in","either"]="out", target_types: list[str]=[], children: list[StepItem]=[])`
  - `FilterStep(kind="filter", criteria: list[Criterion]=[])`
  - `StepItem = Annotated[Union[RelationshipStep, FilterStep], Field(discriminator="kind")]`
  - `PathNavigation.steps: list[StepItem]`, `SCHEMA_VERSION = 2`
  - `evaluate(metamodel, model, defn, limits=EvalLimits()) -> ChainResult` unchanged signature; `ChainResult.step_types` now lists one entry per **relationship** step.

- [ ] **Step 1: Write the failing schema tests**

Replace the `Step` import and `_path` helper in `tests/navigation/test_schema.py`, and add v2 tests. Concretely, set the top of the file to:

```python
"""NavigationDefinition schema-shape tests (schema v2): each step is a
relationship hop (`kind="relationship"`) or a filter (`kind="filter"`).
Relationship steps carry a reserved-empty `children` slot (branch-ready;
non-empty rejected); a definition is capped at MAX_STEPS total items."""

import pytest
from pydantic import ValidationError

from data_rover.core.navigation.schema import (
    MAX_STEPS,
    NAVIGATION_ADAPTER,
    FilterStep,
    Operand,
    PathNavigation,
    RelationshipStep,
    Scope,
    SetExpression,
)
from data_rover.core.search.criteria import PropertyCriterion


def _rel(rt: str = "Owns") -> dict:
    return {"kind": "relationship", "relationship_type": rt}


def _path(n_steps: int = 1) -> dict:
    return {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Block"]},
        "steps": [_rel() for _ in range(n_steps)],
    }
```

Then add these tests (append to the file):

```python
def test_relationship_step_parses_with_defaults() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(_path())
    assert isinstance(nav, PathNavigation)
    assert nav.schema_version == 2
    step = nav.steps[0]
    assert isinstance(step, RelationshipStep)
    assert step.direction == "out"
    assert step.target_types == []
    assert step.children == []


def test_relationship_step_carries_target_types() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "scope"},
         "steps": [{"kind": "relationship", "relationship_type": "Owns",
                    "target_types": ["Service", "Database"]}]}
    )
    assert nav.steps[0].target_types == ["Service", "Database"]


def test_filter_step_holds_criteria() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "scope"},
         "steps": [{"kind": "filter",
                    "criteria": [{"type": "property", "name": "cost",
                                  "op": "gt", "value": "100"}]}]}
    )
    step = nav.steps[0]
    assert isinstance(step, FilterStep)
    assert isinstance(step.criteria[0], PropertyCriterion)


def test_interleaved_steps_preserve_order() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "scope"},
         "steps": [_rel("Owns"), {"kind": "filter", "criteria": []}, _rel("Uses")]}
    )
    kinds = [s.kind for s in nav.steps]
    assert kinds == ["relationship", "filter", "relationship"]


def test_relationship_children_rejected() -> None:
    with pytest.raises(ValidationError):
        RelationshipStep(relationship_type="Owns",
                         children=[RelationshipStep(relationship_type="Uses")])


def test_step_cap_counts_all_items() -> None:
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(_path(MAX_STEPS + 1))
```

Delete any pre-existing `test_schema.py` tests that assert the old `Step`/`target`/`children<=1`/`schema_version == 1` shape (search the file for `Step(`, `.target`, `relationship_type": "Owns"}` without a `kind`, and `schema_version == 1`), replacing their intent with the tests above.

- [ ] **Step 2: Run schema tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_schema.py -v`
Expected: FAIL — `ImportError: cannot import name 'RelationshipStep'` (schema not yet updated).

- [ ] **Step 3: Implement the schema v2 union**

In `src/data_rover/core/navigation/schema.py`: set `SCHEMA_VERSION = 2`. Replace the `Step` class with:

```python
class RelationshipStep(BaseModel):
    """A hop: traverse `relationship_type` (subtype-inclusive) in `direction`,
    landing on `target_types` (subtype-inclusive; empty = any). Carries NO
    criteria — filtering lives in `FilterStep`. `children` is reserved for
    post-Stage-1 branching and MUST be empty in schema v2."""

    kind: Literal["relationship"] = "relationship"
    relationship_type: str
    direction: Literal["out", "in", "either"] = "out"
    target_types: list[str] = Field(default_factory=list)
    children: list["StepItem"] = Field(default_factory=list)

    @model_validator(mode="after")
    def _v2_is_linear(self) -> "RelationshipStep":
        if self.children:
            raise ValueError(
                "branching steps (`children`) are not supported in schema v2"
            )
        return self


class FilterStep(BaseModel):
    """Prunes the current frontier in place: keep an element iff it matches
    ALL criteria. Adds no chain column (see the evaluator). Criteria reuse the
    shared search vocabulary; property criteria are existence-gated at
    evaluation time."""

    kind: Literal["filter"] = "filter"
    criteria: list[Criterion] = Field(default_factory=list)


StepItem = Annotated[
    Union[RelationshipStep, FilterStep], Field(discriminator="kind")
]
```

Change `PathNavigation.steps` to `steps: list[StepItem] = Field(default_factory=list)` (the `_cap_steps` validator stays — it now caps total items). Update the module docstring's "CHAIN CONVENTION" paragraph to note that only relationship steps add a column. Update the `model_rebuild()` block to rebuild the new classes:

```python
RelationshipStep.model_rebuild()
FilterStep.model_rebuild()
PathNavigation.model_rebuild()
Operand.model_rebuild()
SetExpression.model_rebuild()
```

(Delete the old `Step.model_rebuild()`.)

- [ ] **Step 4: Run schema tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/test_schema.py -v`
Expected: PASS (all schema tests green).

- [ ] **Step 5: Write the failing evaluator tests**

In `tests/navigation/test_evaluate_path.py`, update its step-building helpers to the v2 shape (search for dicts/objects that build `relationship_type`/`target` steps and rewrite them: a hop becomes `RelationshipStep(relationship_type=..., direction=..., target_types=[...])`, and any old `target={"types":[...], "criteria":[...]}` splits into a `RelationshipStep(target_types=[...])` followed by a `FilterStep(criteria=[...])`). Add these behavioural tests (adapt the metamodel/model fixture names to the ones already used at the top of the file):

```python
def test_filter_step_prunes_without_adding_column(mm, model):
    # A relationship step lands on mixed types; a filter step keeps only those
    # with cost > 100. The chain width stays start + 1 (the filter adds no col).
    defn = PathNavigation(
        kind="path",
        start=Scope(types=["Component"]),
        steps=[
            RelationshipStep(relationship_type="Uses"),
            FilterStep(criteria=[PropertyCriterion(
                type="property", name="cost", op="gt", value="100")]),
        ],
    )
    result = evaluate(mm, model, defn)
    assert result.step_types == ["Uses"]          # filter contributes no header
    assert all(len(chain) == 2 for chain in result.chains)


def test_property_criterion_is_existence_gated(mm, model):
    # An element lacking `cost` must be dropped, not coerced to "".
    defn = PathNavigation(
        kind="path",
        start=Scope(criteria=[PropertyCriterion(
            type="property", name="cost", op="gte", value="0")]),
        steps=[],
    )
    ids = {c[0] for c in evaluate(mm, model, defn).chains}
    assert all("cost" in model.elements[i].properties for i in ids)


def test_target_types_filter_landing(mm, model):
    defn = PathNavigation(
        kind="path",
        start=Scope(types=["Component"]),
        steps=[RelationshipStep(relationship_type="Uses",
                                target_types=["Database"])],
    )
    for chain in evaluate(mm, model, defn).chains:
        assert mm.is_element_subtype(model.elements[chain[1]].type_name, "Database")
```

Ensure the imports at the top of `test_evaluate_path.py` include `RelationshipStep, FilterStep, Scope, PathNavigation` from `data_rover.core.navigation.schema` and `PropertyCriterion` from `data_rover.core.search.criteria`.

- [ ] **Step 6: Run evaluator tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_evaluate_path.py -v`
Expected: FAIL — `ImportError` (evaluator still imports `Step`) or attribute errors on `RelationshipStep`.

- [ ] **Step 7: Rewrite the evaluator**

In `src/data_rover/core/navigation/evaluate.py`:

Change the schema import to:

```python
from .schema import (
    FilterStep,
    NavigationDefinition,
    PathNavigation,
    RelationshipStep,
    Scope,
    SetExpression,
)
```

Add `PropertyCriterion` to the criteria import:

```python
from data_rover.core.search.criteria import PropertyCriterion, match_element
```

Replace the `PathNavigation` branch of `evaluate` with:

```python
    start_ids = _start_ids(metamodel, model, defn, limits, budget)
    chains: list[tuple[str, ...]] = []
    truncated = False
    for start_id in start_ids:
        if _walk(
            metamodel, model, defn.steps, 0, (start_id,), chains, limits,
            budget, defn.exclude_visited,
        ):
            truncated = True
            break
    return ChainResult(
        step_types=[
            s.relationship_type for s in defn.steps
            if isinstance(s, RelationshipStep)
        ],
        chains=chains,
        truncated=truncated or budget.exhausted,
    )
```

Replace `_matches_criteria`/`_matches_target`/`_next_ids`/`_walk` with:

```python
def _match_nav_criterion(model: Model, element: Element, criterion) -> bool:
    """Navigation criterion match. Property criteria are EXISTENCE-GATED: the
    element must actually carry the property (except `exists`/`is_empty`, which
    handle absence explicitly). This intentionally diverges from the shared
    search matcher's coerce-missing-to-'' semantics — `core/search` is
    untouched, so `/model/search` stays byte-identical."""
    if isinstance(criterion, PropertyCriterion) and criterion.op not in (
        "exists",
        "is_empty",
    ):
        if criterion.name not in element.properties:
            return False
    return match_element(model, element, criterion)


def _matches_criteria(model: Model, element: Element, scope: Scope) -> bool:
    return all(_match_nav_criterion(model, element, c) for c in scope.criteria)


def _matches_filter(model: Model, element: Element, step: FilterStep) -> bool:
    return all(_match_nav_criterion(model, element, c) for c in step.criteria)


def _matches_target_types(
    metamodel: Metamodel, element: Element, target_types: list[str]
) -> bool:
    if not target_types:
        return True
    return any(
        metamodel.is_element_subtype(element.type_name, t) for t in target_types
    )


def _hop(
    metamodel: Metamodel,
    model: Model,
    element_id: str,
    step: RelationshipStep,
    budget: _Budget,
) -> list[str]:
    idx = model.indexes
    if step.direction == "out":
        rel_ids = set(idx.outgoing_ids(element_id))
    elif step.direction == "in":
        rel_ids = set(idx.incoming_ids(element_id))
    else:  # either — union dedupes self-loops present in both directions
        rel_ids = set(idx.outgoing_ids(element_id)) | set(idx.incoming_ids(element_id))
    if not budget.spend(len(rel_ids)):
        return []
    nxt: set[str] = set()
    for rid in rel_ids:
        rel = model.relationships[rid]
        if not metamodel.is_relationship_subtype(
            rel.type_name, step.relationship_type
        ):
            continue
        other = rel.target_id if rel.source_id == element_id else rel.source_id
        el = model.elements.get(other)
        if el is not None and _matches_target_types(metamodel, el, step.target_types):
            nxt.add(other)
    return sorted(nxt)


def _walk(
    metamodel: Metamodel,
    model: Model,
    steps: list,
    item_idx: int,
    chain: tuple[str, ...],
    chains: list[tuple[str, ...]],
    limits: EvalLimits,
    budget: _Budget,
    exclude_visited: bool,
) -> bool:
    """DFS over the interleaved step-item list. A RelationshipStep extends the
    chain by one hop (deterministic, sorted-id); a FilterStep keeps the chain
    iff its current endpoint matches all criteria, adding no column. Returns
    True when enumeration stopped early (chain cap or budget)."""
    if item_idx == len(steps):
        if len(chains) >= limits.max_chains:
            return True
        chains.append(chain)
        return False
    step = steps[item_idx]
    current = chain[-1]
    if isinstance(step, FilterStep):
        if _matches_filter(model, model.elements[current], step):
            return _walk(
                metamodel, model, steps, item_idx + 1, chain, chains, limits,
                budget, exclude_visited,
            )
        return False
    nxt = _hop(metamodel, model, current, step, budget)
    if budget.exhausted:
        return True
    for other in nxt:
        if exclude_visited and other in chain:
            continue  # cycle guard: a chain never revisits its own elements
        if _walk(
            metamodel, model, steps, item_idx + 1, chain + (other,), chains,
            limits, budget, exclude_visited,
        ):
            return True
    return False
```

Keep `_start_ids`, `_scope_ids` (it already calls `_matches_criteria`, now existence-gated), `_evaluate_set`, `_operand_members`, `EvalLimits`, `ChainResult`, `_Budget`, and the `SetExpression` branch of `evaluate` unchanged. Remove the now-unused `Step` reference and the old `_matches_target`/`_next_ids` names.

- [ ] **Step 8: Run evaluator + set tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/ -v`
Expected: PASS. If `test_evaluate_sets.py` or `test_resolve.py` fail with import/attribute errors, they build steps with the old shape — update those step constructions to `RelationshipStep(...)` (a bare hop) exactly as in Step 5, then re-run.

- [ ] **Step 9: Update the API route tests to the v2 step shape**

In `tests/api/test_artifacts_routes.py`, add `"kind": "relationship"` to every step dict. Concretely:
- Line ~21: `"steps": [{"kind": "relationship", "relationship_type": "BlockHasPart"}],`
- Line ~166: same edit.
- Lines ~190–191: `"steps": [{"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"}, {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "in"}],`

Search the file for any other `"relationship_type"` occurrences inside a `"steps"` list and add `"kind": "relationship"` to each.

- [ ] **Step 10: Run the full core suite to verify green**

Run: `pixi run test-core`
Expected: PASS (all of `tests/` including `tests/navigation` and `tests/api`). If any `tests/api` navigation payload still fails, it is missing `"kind": "relationship"` — fix and re-run.

- [ ] **Step 11: Lint**

Run: `pixi run lint-core && pixi run lint-backend`
Expected: ruff + mypy + pyright all clean. Fix any type issues (e.g. annotate `steps: list[StepItem]` in `_walk`'s signature if pyright wants it; use `Sequence[StepItem]` from `collections.abc` if invariance complains).

- [ ] **Step 12: Commit**

```bash
git add src/data_rover/core/navigation/schema.py src/data_rover/core/navigation/evaluate.py tests/navigation/ tests/api/test_artifacts_routes.py
git commit -m "$(cat <<'EOF'
feat(navigation): schema v2 — relationship/filter steps + existence-gated filtering

Split each step into a relationship hop (rel-type + direction + optional
target_types) or a filter (criteria pruning the frontier in place, no chain
column). Navigation property criteria are existence-gated; search is untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backend verification sweep

**Files:** none (verification only).

**Interfaces:**
- Consumes: the Task 1 core engine.
- Produces: a green backend baseline for the frontend plan.

- [ ] **Step 1: Full core suite**

Run: `pixi run test-core`
Expected: PASS, zero regressions (warnings are pre-existing asyncio-deprecation framework noise).

- [ ] **Step 2: Search parity guard**

Run: `pixi run -e core-dev pytest tests/api/test_search_routes.py tests/validation -v`
Expected: PASS — confirms `core/search/criteria.py` behaviour is unchanged (the existence gate did not leak into search).

- [ ] **Step 3: Tidy**

Run: `pixi run tidy`
Expected: all gates green. If it reformats files this branch never touched (pre-existing drift), `git checkout --` those files to keep the diff scoped, then re-run.

- [ ] **Step 4: Commit only if tidy changed branch-owned files**

```bash
git status --short
# If only this branch's files were reformatted:
git add -A && git commit -m "$(cat <<'EOF'
style(navigation): ruff/format pass on v2 core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
# Otherwise (clean tree): nothing to commit.
```

---

## Self-review notes (for the executor)

- **Spec coverage:** schema v2 union (Task 1 §3), evaluator interleaved walk + `step_types` = rel steps (§7), existence-gated property matching + start-scope coverage (§7), `target_types`-only hop (§7), no migration (v2 only), search untouched (Task 2 §2). All present.
- **Type consistency:** `RelationshipStep`/`FilterStep`/`StepItem` names are identical across schema, evaluator, and tests; `evaluate`/`ChainResult`/`EvalLimits` signatures unchanged.
- **Known intermediate:** after Step 3 the evaluator and `tests/api` are momentarily inconsistent; they are all fixed within Task 1 before its single commit — do not commit between Step 3 and Step 12.
