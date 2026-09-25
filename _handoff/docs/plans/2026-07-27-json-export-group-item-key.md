# JSON export: separate group and item keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a grouped JSON-export column name its array and its per-entry value independently — `{"Signals": [{"One Signal": "S1", "Mass": 3}]}` instead of `"Signal"` for both.

**Architecture:** One additive field, `JsonColumnOptions.item_key`. `resolve_json_keys` is untouched and keeps producing the key at each column's home level (the array name for a grouped column); a new second pass, `resolve_item_keys`, produces the key a grouped column uses for its own value inside its entries. `_render_level` picks between the two with a single predicate. The settings pane grows a second, labelled input that appears only on grouped rows.

**Tech Stack:** Python 3.14 + pydantic v2 (core), pytest, SvelteKit 5 + zod + vitest (frontend). Everything runs through `pixi run`.

**Spec:** `docs/superpowers/specs/2026-07-27-json-export-group-item-key-design.md`

## Global Constraints

- Blank `item_key` MUST fall back to the **resolved group key** (`jkeys[i]`), never to the raw header — every table saved before this change has to export byte-identically.
- `resolve_item_keys` runs **after** `resolve_json_keys` and dedupes against its output, so a group key always wins a collision.
- An item key that equals the column's own group key is emitted **verbatim**, exempt from the `_2`/`_3` uniqueness loop (same column, two levels).
- `item_key` on a non-grouped, collapse-mode, or hidden column is **ignored, never rejected** — the same tolerance `group` already has.
- `render_json`'s public signature does not change; `api/routes/tables.py` needs no edit.
- Python target is 3.14: PEP 604 unions (`str | None`), `from __future__ import annotations` already at the top of the touched module.
- Preserve the existing docstring style in `core/table/json_export.py` — dense, explaining *why* an invariant exists.

---

### Task 1: `item_key` field + `resolve_item_keys`

**Files:**
- Modify: `src/data_rover/core/table/schema.py:101-123` (`JsonColumnOptions`)
- Modify: `src/data_rover/core/table/json_export.py` (add `_honors_group` + `resolve_item_keys`; reuse `_honors_group` inside `build_group_plan`)
- Test: `tests/table/test_json_export.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `JsonColumnOptions.item_key: str` (default `""`)
  - `_honors_group(col: Column) -> bool`
  - `resolve_item_keys(defn: TableDefinition, jkeys: list[str | None]) -> list[str | None]` — one entry per definition column, `None` for every column that is not a group-honoring visible column.

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_json_export.py`. Add `resolve_item_keys` to the existing `from data_rover.core.table.json_export import (...)` block at the top of the file (alongside `resolve_json_keys`).

```python
def _grouped(**over) -> dict:
    """A visible expand column with `group` on — the only shape whose
    `item_key` is honored."""
    col = {
        "kind": "property",
        "source": {"kind": "row"},
        "name": "mass",
        "mode": "expand",
        "header": "Signal",
        "json_export": {"group": True},
    }
    col.update(over)
    return col


def _item_keys(*cols):
    defn = _defn(columns=list(cols))
    return resolve_item_keys(defn, resolve_json_keys(defn))


def test_item_key_defaults_to_empty():
    defn = _defn(columns=[_grouped()])
    opts = defn.columns[0].json_export
    assert opts is not None
    assert opts.item_key == ""


def test_blank_item_key_falls_back_to_the_resolved_group_key():
    assert _item_keys(_grouped(json_export={"group": True, "key": "Signals"})) == [
        "Signals"
    ]


def test_explicit_item_key_wins():
    keys = _item_keys(
        _grouped(json_export={"group": True, "key": "Signals", "item_key": "One Signal"})
    )
    assert keys == ["One Signal"]


def test_item_key_is_none_for_a_column_that_does_not_group():
    keys = _item_keys(
        {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
        _grouped(json_export={"group": True, "item_key": "ignored"}, mode="collapse"),
    )
    assert keys == [None, None]


def test_item_key_is_none_for_a_hidden_grouped_column():
    assert _item_keys(_grouped(hidden=True, json_export={"group": True})) == [None]


def test_an_item_key_equal_to_its_own_group_key_is_not_suffixed():
    """The group key and the item key name the SAME column at two levels, so
    the global 'one key, one column' namespace is not violated and a `_2`
    suffix would be pure noise."""
    keys = _item_keys(_grouped(json_export={"group": True, "key": "Signal"}))
    assert keys == ["Signal"]


def test_an_explicit_item_key_colliding_with_another_column_is_suffixed():
    keys = _item_keys(
        {"kind": "element", "source": {"kind": "row"}, "header": "Mass"},
        _grouped(json_export={"group": True, "key": "Signals", "item_key": "Mass"}),
    )
    assert keys == [None, "Mass_2"]


def test_two_explicit_item_keys_that_collide_are_suffixed():
    keys = _item_keys(
        _grouped(json_export={"group": True, "key": "A", "item_key": "one"}),
        _grouped(json_export={"group": True, "key": "B", "item_key": "one"}),
    )
    assert keys == ["one", "one_2"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -k item_key -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_item_keys'`.

- [ ] **Step 3: Add the schema field**

In `src/data_rover/core/table/schema.py`, inside `JsonColumnOptions`, immediately after the `key` field:

```python
    #: Key for the column's OWN value inside the array entries `group`
    #: produces. Meaningful only where `group` is honored; "" falls back to
    #: the RESOLVED group key — which is exactly what the single key this
    #: field splits already did, so old definitions export unchanged.
    item_key: str = ""
```

- [ ] **Step 4: Add `_honors_group` and `resolve_item_keys`**

In `src/data_rover/core/table/json_export.py`, add after `resolve_json_keys`:

```python
def _honors_group(col: Column) -> bool:
    """Whether this column's `group` flag is actually acted on: set, on a
    VISIBLE EXPAND column. A stale flag anywhere else is IGNORED rather than
    rejected — the column editor can flip expand->collapse at any moment and a
    422 would block exporting the whole table over a leftover checkbox."""
    return (
        col.json_export is not None
        and col.json_export.group
        and not col.hidden
        and getattr(col, "mode", "collapse") == "expand"
    )


def resolve_item_keys(
    defn: TableDefinition, jkeys: list[str | None]
) -> list[str | None]:
    """Per definition column, the key a GROUPED column uses for its own value
    inside its array entries; `None` for every column that does not group.

    Positionally aligned with `jkeys`, and deliberately a SECOND pass over it:
    resolving group keys first means a group key always wins a collision, which
    is what keeps definitions written before `item_key` existed rendering
    byte-identically.

    A blank `item_key` — and an explicit one that repeats the column's own
    group key — is taken VERBATIM rather than uniquified. The two names belong
    to the same column at two nesting levels, so the global "one key means one
    column" invariant `resolve_json_keys` maintains still holds; suffixing it
    to `Signals_2` would be noise. Any OTHER explicit key joins that global
    namespace and takes `_2`, `_3`, ... on a clash.
    """
    out: list[str | None] = []
    used = {k for k in jkeys if k is not None}
    for i, col in enumerate(defn.columns):
        own = jkeys[i]
        if own is None or not _honors_group(col):
            out.append(None)  # hidden, or never rendered as a group
            continue
        opts = col.json_export
        base = (opts.item_key if opts is not None else "") or own
        if base == own:
            out.append(own)
            continue
        key = base
        n = 2
        while key in used:
            key = f"{base}_{n}"
            n += 1
        used.add(key)
        out.append(key)
    return out
```

- [ ] **Step 5: Reuse the predicate in `build_group_plan`**

In `build_group_plan`, replace the inlined condition with the shared helper so the two passes can never drift:

```python
    grouped = tuple(i for i, c in enumerate(defn.columns) if _honors_group(c))
```

Trim the now-duplicated "honored only on a VISIBLE EXPAND column" sentence from `build_group_plan`'s docstring down to a pointer — `_honors_group` carries the rationale:

```python
    `group` is honored only where `_honors_group` says so; a stale flag
    elsewhere is ignored, not rejected.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS — the new `item_key` tests plus all 40+ pre-existing ones (the `build_group_plan` refactor must not move any of them).

- [ ] **Step 7: Lint and typecheck**

Run: `pixi run core-lint`
Expected: ruff, mypy and pyright all clean.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/core/table/schema.py src/data_rover/core/table/json_export.py tests/table/test_json_export.py
git commit -m "feat(table): resolve a separate item key for grouped JSON columns"
```

---

### Task 2: Render the item key

**Files:**
- Modify: `src/data_rover/core/table/json_export.py:220-327` (`render_json`, `_render_level`, `_render_group`)
- Test: `tests/table/test_json_export.py`, `tests/api/test_table_export_json.py`

**Interfaces:**
- Consumes: `resolve_item_keys(defn, jkeys) -> list[str | None]` from Task 1.
- Produces: no new public names. `render_json(model, defn, row_keys, row_iter, base_slots)` keeps its exact signature, so `api/routes/tables.py:783` and `:890` are untouched.

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_json_export.py`. These use the file's existing `_render`/`_parts_mm`/`_parts_model` helpers (around line 644-722), which build real rows through `build_rows_ex`.

```python
def _nav_group(json_export: dict) -> dict:
    """`_hop_nav('expand', group=True)` with the json_export block spelled out,
    so a test can set `key`/`item_key` on it."""
    col = _hop_nav("expand", group=False)
    col["json_export"] = json_export
    return col


def test_item_key_names_the_value_inside_a_group():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group(
                    {"group": True, "key": "Components", "item_key": "One Component"}
                ),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {
        "Name": "Root",
        "Components": [
            {"One Component": "Part 1", "Component Mass": 12},
            {"One Component": "Part 2", "Component Mass": 9},
        ],
    }


def test_a_blank_item_key_still_repeats_the_group_key():
    """Back-compat: this is the pre-`item_key` output, verbatim."""
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group({"group": True, "key": "Components"}),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {
        "Name": "Root",
        "Components": [
            {"Components": "Part 1", "Component Mass": 12},
            {"Components": "Part 2", "Component Mass": 9},
        ],
    }


def test_item_key_is_unused_when_the_group_unwraps_to_scalars():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group({"group": True, "key": "Components", "item_key": "each"}),
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {"Name": "Root", "Components": ["Part 1", "Part 2"]}


def test_a_grouped_column_keeps_its_group_key_at_the_top_level():
    """The array's own name comes from `key`, never from `item_key` — the
    grouped column is in its home level's group set."""
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group({"group": True, "key": "Components", "item_key": "each"}),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert set(root) == {"Name", "Components"}
    assert set(root["Components"][0]) == {"each", "Component Mass"}
```

And append to `tests/api/test_table_export_json.py`:

```python
def test_json_export_accepts_item_key_over_the_wire(client):
    """`item_key` has to survive TABLE_ADAPTER validation and reach the
    renderer without disturbing the array's own name. The NESTED shape it
    produces is pinned in tests/table/test_json_export.py, which can build a
    dependent column against a metamodel it controls — this fixture's
    relationships are `_bootstrap_model`'s business, so asserting a nested
    object here would pin the fixture rather than the feature."""
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "mode": "expand",
                "header": "Mass",
                "json_export": {
                    "group": True,
                    "key": "Masses",
                    "item_key": "One Mass",
                },
            },
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    docs = json.loads(r.content)
    assert set(docs[0]) == {"Block", "Masses"}
    assert isinstance(docs[0]["Masses"], list)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -k "item_key or group_key" -v`
Expected: FAIL — `test_item_key_names_the_value_inside_a_group` reports `"Components"` where `"One Component"` is expected (the renderer still uses the group key at both levels).

- [ ] **Step 3: Bundle the two key lists**

In `src/data_rover/core/table/json_export.py`, add next to `GroupPlan`:

```python
@dataclass(frozen=True)
class JsonKeys:
    """The resolved names, one entry per definition column.

    `level` is the key at a column's HOME level — for a grouped column that is
    the array's name. `item` is the key a grouped column uses for its own value
    INSIDE its entries, and is `None` for every column that does not group.
    Bundled rather than passed as two parallel lists so the recursive renderers
    keep their arity.
    """

    level: list[str | None]
    item: list[str | None]

    @staticmethod
    def resolve(defn: TableDefinition) -> JsonKeys:
        level = resolve_json_keys(defn)
        return JsonKeys(level=level, item=resolve_item_keys(defn, level))
```

- [ ] **Step 4: Thread it through the renderers**

In `render_json`, replace `jkeys = resolve_json_keys(defn)` with:

```python
    keys = JsonKeys.resolve(defn)
```

and the return with:

```python
    return [
        _render_level(model, defn, keys, plan, plan.top_columns, plan.top_groups, b)
        for b in buckets
    ]
```

In `_render_level`, change the parameter `jkeys: list[str | None]` to `keys: JsonKeys`, and replace the body's key lookup. Add to its docstring:

```python
    A grouped column appears in exactly two places: as an ARRAY at its home
    level (where it is in `group_set`) and as the plain leading member of its
    OWN entry level (where it is not — `build_group_plan` routes every other
    grouped column to `children`). That is the whole rule for picking between
    the two names.
```

```python
    group_set = set(groups)
    obj: dict[str, object] = {}
    for i in sorted([*columns, *groups]):
        if i in group_set:
            key = keys.level[i]
            if key is None:  # hidden: evaluated, never emitted
                continue
            obj[key] = _render_group(model, defn, keys, plan, i, rows)
        else:
            # A grouped column reached here is rendering its own value inside
            # its own entries, which is what `item` names.
            key = keys.item[i] if i in plan.grouped else keys.level[i]
            if key is None:  # hidden: evaluated, never emitted
                continue
            obj[key] = render_cell(model, rows[0][1][i], _mode_of(defn.columns[i]))
    return obj
```

In `_render_group`, change the same parameter to `keys: JsonKeys` and pass `keys` through to `_render_level`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py tests/api/test_table_export_json.py -v`
Expected: PASS, including every pre-existing grouping test — `test_grouping_nests_a_dependent_column` is the back-compat canary.

- [ ] **Step 6: Lint and typecheck**

Run: `pixi run core-lint`
Expected: clean. (`JsonKeys.resolve` returning `JsonKeys` relies on the `from __future__ import annotations` already at the top of the module.)

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/core/table/json_export.py tests/table/test_json_export.py tests/api/test_table_export_json.py
git commit -m "feat(table): render a grouped JSON column's array and item keys separately"
```

---

### Task 3: Frontend schema and defaults

**Files:**
- Modify: `frontend/src/lib/api/types.ts:716-724` (`JsonColumnOptionsSchema`)
- Modify: `frontend/src/lib/table/columns.ts:298` (`DEFAULT_JSON_OPTIONS`)
- Test: `frontend/src/lib/table/__tests__/columns.test.ts:653-666`

**Interfaces:**
- Consumes: the backend field name `item_key` from Task 1 — snake_case on the wire, no camelCase mapping anywhere in this codebase.
- Produces: `JsonColumnOptions` (the zod-inferred type) now carries a required `item_key: string`; `setColumnJsonOptions(defn, index, patch)` accepts `{ item_key }` in its `Partial<JsonColumnOptions>` patch.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/table/__tests__/columns.test.ts`, update the two `setColumnJsonOptions` expectations (they assert whole objects, so the new default has to appear) and add one:

```ts
	it('creates the options object when absent and keeps other columns', () => {
		const d = defn(el({ header: 'A' }), el({ header: 'B' }));
		const next = setColumnJsonOptions(d, 1, { key: 'b' });
		expect(next.columns[1].json_export).toEqual({
			key: 'b',
			item_key: '',
			value: 'name',
			group: false
		});
		expect(next.columns[0].json_export).toBeUndefined();
		expect(d.columns[1].json_export).toBeUndefined(); // input not mutated
	});

	it('merges into existing options', () => {
		const d = defn(el({ json_export: { key: 'a', item_key: '', value: 'id', group: false } }));
		const next = setColumnJsonOptions(d, 0, { group: true });
		expect(next.columns[0].json_export).toEqual({
			key: 'a',
			item_key: '',
			value: 'id',
			group: true
		});
	});

	it('patches the item key without disturbing the group key', () => {
		const d = defn(el({ json_export: { key: 'Signals', item_key: '', value: 'name', group: true } }));
		const next = setColumnJsonOptions(d, 0, { item_key: 'One Signal' });
		expect(next.columns[0].json_export).toEqual({
			key: 'Signals',
			item_key: 'One Signal',
			value: 'name',
			group: true
		});
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/table/__tests__/columns.test.ts'`
Expected: FAIL — the received objects have no `item_key` key.

- [ ] **Step 3: Add the field to the zod schema**

In `frontend/src/lib/api/types.ts`, inside `JsonColumnOptionsSchema`, directly after `key`:

```ts
	item_key: z.string().default(''),
```

Extend the schema's leading comment so it stays an accurate mirror:

```ts
/** Per-column JSON-export settings. Mirrors core/table/schema.py's
 *  JsonColumnOptions. `group` is honored by the backend only on a VISIBLE
 *  EXPAND column; a stale flag elsewhere is ignored, not rejected. `key` names
 *  the column at its home level (the ARRAY, once grouped) and `item_key` names
 *  its own value inside that array's entries; blank falls back to `key`. */
```

- [ ] **Step 4: Add the field to the default options**

In `frontend/src/lib/table/columns.ts`:

```ts
const DEFAULT_JSON_OPTIONS: JsonColumnOptions = {
	key: '',
	item_key: '',
	value: 'name',
	group: false
};
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/table/__tests__/columns.test.ts'`
Expected: PASS.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors — the inferred `JsonColumnOptions` now requires `item_key`, so any other whole-object literal in `src/` would surface here.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/table/columns.ts frontend/src/lib/table/__tests__/columns.test.ts
git commit -m "feat(table): mirror the JSON item_key option in the frontend schema"
```

---

### Task 4: The second input in the settings pane

**Files:**
- Modify: `frontend/src/lib/components/Table/JsonExportEditor.svelte:38-47` (`snakeAll`) and `:114-122` (the Key cell)
- Test: `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts`

**Interfaces:**
- Consumes: `setColumnJsonOptions` accepting `{ item_key }` (Task 3); `defaultJsonKeys(defn)` (unchanged) for the placeholder.
- Produces: `data-testid="json-item-key-{i}"` — the second input, rendered only on a row whose `group` box is checked.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('JsonExportEditor', ...)` block in `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts`. The file's `defn()` fixture already has an expand navigation column at index 1 and a collapse property column at index 0.

```ts
	// The item key names a grouped column's own value INSIDE its array
	// entries; ungrouped rows have one role and keep the single bare input.
	it('shows the item-key input only once a column is grouped', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			expect(testid('json-item-key-1')).toBeNull();
			const box = testid('json-group-1') as HTMLInputElement;
			box.checked = true;
			box.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(testid('json-item-key-1')).not.toBeNull();
			// A collapse column can never group, so it never gets one.
			expect(testid('json-item-key-0')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('writes an edited item key into the definition', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		updateTableDefinition(TAB_ID, setColumnJsonOptions(defn(), 1, { group: true, key: 'Components' }));
		flushSync();
		const c = render();
		try {
			const item = testid('json-item-key-1') as HTMLInputElement;
			item.value = 'One Component';
			item.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			const opts = getTableDraft(TAB_ID)!.definition.columns[1].json_export;
			expect(opts?.item_key).toBe('One Component');
			expect(opts?.key).toBe('Components'); // the group key is untouched
		} finally {
			unmount(c);
		}
	});

	it('placeholds the item key with the resolved group key it falls back to', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		updateTableDefinition(TAB_ID, setColumnJsonOptions(defn(), 1, { group: true, key: 'Components' }));
		flushSync();
		const c = render();
		try {
			expect((testid('json-item-key-1') as HTMLInputElement).placeholder).toBe('Components');
		} finally {
			unmount(c);
		}
	});

	it('snake_cases an explicitly set item key and leaves a blank one blank', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		updateTableDefinition(
			TAB_ID,
			setColumnJsonOptions(defn(), 1, { group: true, item_key: 'One Component' })
		);
		flushSync();
		const c = render();
		try {
			(testid('json-snake-all') as HTMLButtonElement).click();
			flushSync();
			const cols = getTableDraft(TAB_ID)!.definition.columns;
			expect(cols[1].json_export?.item_key).toBe('one_component');
			// Column 0 never had one: it stays blank and keeps following its key.
			expect(cols[0].json_export?.item_key).toBe('');
		} finally {
			unmount(c);
		}
	});
```

Add `setColumnJsonOptions` to the file's `$lib/table/columns` imports (the file currently imports nothing from it — add `import { setColumnJsonOptions } from '$lib/table/columns';` next to the existing `$lib/state` import).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/JsonExportEditor.test.ts'`
Expected: FAIL — `json-item-key-1` is null after ticking the box.

- [ ] **Step 3: Render the two stacked inputs**

In `frontend/src/lib/components/Table/JsonExportEditor.svelte`, add a `{@const}` immediately inside the existing `{#if !col.hidden}` (Svelte 5 allows `{@const}` only as the direct child of a block), and replace the Key `<td>`:

```svelte
				{#if !col.hidden}
					{@const grouped = canGroup(col) && (col.json_export?.group ?? false)}
					<tr class="border-t border-border">
						<td class="py-1 pr-2 text-muted-foreground">{col.header || col.kind}</td>
						<td class="py-1 pr-2">
							<div class="flex flex-col gap-1">
								<label class="flex items-center gap-1">
									{#if grouped}
										<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70">
											array
										</span>
									{/if}
									<input
										data-testid={`json-key-${i}`}
										class="w-full rounded border border-input bg-card px-2 py-1"
										placeholder={keys[i] ?? ''}
										value={col.json_export?.key ?? ''}
										oninput={(e) => patch(i, { key: e.currentTarget.value })}
									/>
								</label>
								{#if grouped}
									<label class="flex items-center gap-1">
										<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70">
											item
										</span>
										<input
											data-testid={`json-item-key-${i}`}
											class="w-full rounded border border-input bg-card px-2 py-1"
											placeholder={keys[i] ?? ''}
											value={col.json_export?.item_key ?? ''}
											oninput={(e) => patch(i, { item_key: e.currentTarget.value })}
										/>
									</label>
								{/if}
							</div>
						</td>
```

Extend the component's header comment (line 2) to name the new role:

```svelte
	// The "JSON export" settings tab: one row per VISIBLE column (key, element
	// rendering, group), plus a live sample. A grouped column names two things
	// — the array at its parent level and its own value inside each entry — so
	// its Key cell carries a second "item" input; blank means "same as array",
	// which is what the placeholder shows.
```

The item input is shown for every grouped column, including one whose group currently unwraps to bare values and emits no item key at all. Deciding otherwise means reimplementing `build_group_plan`'s ownership walk in TypeScript — the drift the backend-rendered preview exists to prevent — and the preview already shows the truth.

- [ ] **Step 4: Teach `snake_case all` about item keys**

Replace the body of `snakeAll`:

```ts
	function snakeAll(): void {
		if (!defn) return;
		let next: TableDefinition = defn;
		const derived = defaultJsonKeys(defn);
		derived.forEach((k, i) => {
			if (k === null) return; // hidden: no key to rewrite
			// A blank item key keeps following the (now snaked) group key —
			// writing one would only freeze today's fallback into the payload.
			const item = defn.columns[i].json_export?.item_key ?? '';
			next = setColumnJsonOptions(
				next,
				i,
				item ? { key: snakeCaseKey(k), item_key: snakeCaseKey(item) } : { key: snakeCaseKey(k) }
			);
		});
		updateTableDefinition(tabId, next);
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/JsonExportEditor.test.ts'`
Expected: PASS, including the pre-existing `shows the derived key as a placeholder...` and `snake_cases every visible column at once...` tests.

- [ ] **Step 6: Run the whole frontend suite and the typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: PASS / 0 errors.

- [ ] **Step 7: Format and lint everything**

Run: `pixi run dr-tidy`
Expected: clean; re-run the two suites above if it reformats anything.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/components/Table/JsonExportEditor.svelte frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts
git commit -m "feat(table): add the item-key input to the JSON export settings pane"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 1. `JsonColumnOptions.item_key`, blank falls back to resolved group key | Task 1 (steps 3-4), Task 3 (frontend mirror) |
| 2. Key resolution: second pass, verbatim-when-equal, global dedupe | Task 1 (steps 4, 6) |
| 3. Rendering: grouped-but-not-in-`group_set` predicate; unwrap unaffected | Task 2 |
| 4. Settings pane: stacked `array`/`item` inputs, placeholder, always-shown, `snake_case all` | Task 4 |
| Testing: core, api, JsonExportEditor, columns | Tasks 1, 2, 3, 4 respectively |
| Out of scope (singularization, per-level namespaces, renames) | not planned — correct |

**Type consistency** — `item_key` is the field name in pydantic, zod, every patch object and every test, front to back. `resolve_item_keys(defn, jkeys)` is defined in Task 1 and consumed only through `JsonKeys.resolve` in Task 2. `_honors_group` is defined once and used by both `build_group_plan` and `resolve_item_keys`. `render_json`'s signature is unchanged, so `api/routes/tables.py` stays untouched — asserted in Task 2's Interfaces block.

**Placeholder scan** — every step carries the literal code or the exact command and its expected result.
