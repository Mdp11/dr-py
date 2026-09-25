# JSON export: separate group and item keys

Date: 2026-07-27
Area: `core/table/json_export.py`, `core/table/schema.py`, `frontend/src/lib/components/Table/JsonExportEditor.svelte`
Builds on: `docs/superpowers/specs/2026-07-25-table-json-export-design.md`

## Problem

A grouped column carries one JSON key that serves two roles at two nesting
levels: it names the array at the parent level, and it names the column's own
value inside each array entry. A column "Signal" grouped alongside a "Mass"
column therefore exports

```json
{ "Part": "Wing", "Signal": [ { "Signal": "S1", "Mass": 3 } ] }
```

with no way to say "the array is `Signals`, each entry's own value is
`One Signal`". Ungrouped columns are unaffected — they have one role and one
key, which is already right.

## Design

### 1. `JsonColumnOptions.item_key`

`core/table/schema.py`'s `JsonColumnOptions` gains one additive field:

```python
#: Key for the column's OWN value inside the group's array entries. Meaningful
#: only when `group` is honored; "" falls back to the resolved group key.
item_key: str = ""
```

`key` keeps its existing meaning — the column's key at its home level, which
for a grouped column is the array's name. This split is chosen over the inverse
(`key` = item, new field = array) because the pane's existing "Key" input is
what a user renames first when they tick Group: "Signal" -> "Signals".

Blank `item_key` falls back to the **resolved group key**, not to the raw
header, so every table saved before this change exports byte-identically. The
consequence — filling in only the group key renames the inner key too — is
accepted; the second input is right there to fix it.

Mirrored in `frontend/src/lib/api/types.ts` (`JsonColumnOptionsSchema`) and in
`DEFAULT_JSON_OPTIONS` in `frontend/src/lib/table/columns.ts`. No migration and
no version bump: the field defaults to current behaviour, and a payload written
by an older client simply omits it.

### 2. Key resolution

`resolve_json_keys` is unchanged. A new `resolve_item_keys(defn, jkeys)` runs as
a **second pass** over its output and returns one entry per definition column:
the item key for a visible column whose `group` flag is honored, `None`
everywhere else.

Per such column, base is the explicit `item_key`, else the column's resolved
group key `jkeys[i]`.

- A base equal to the column's own group key is taken **verbatim**, exempt from
  the uniqueness loop. It is the same column named at two levels, so the global
  "one key means one column" invariant holds; suffixing it to `Signals_2` would
  be noise.
- Any other base is uniquified against the same global namespace with the same
  `_2`, `_3`, ... loop, seeded with every resolved group key and every item key
  already assigned.

Running item keys strictly after group keys means group keys always win a
collision, which is what keeps pre-existing exports stable.

### 3. Rendering

`_render_level` currently reads `jkeys[i]` for every column it emits. A grouped
column `g` appears in exactly two places in the document:

- as an array at its home level — `g` is in that level's `groups`, hence in
  `group_set`;
- as a plain member at the head of its own entry level — `members[g]` always
  starts with `g`, and `members` never holds any *other* grouped column
  (`build_group_plan` routes those to `children`).

So the key choice is a single predicate: a column that is in `plan.grouped` but
**not** in this level's `group_set` is the group's own value and takes
`ikeys[i]`; everything else takes `jkeys[i]`. `render_json` threads the second
list through alongside `jkeys`.

The unwrapped case — a group holding only itself with nothing nested, which
`_render_group` renders as bare values — emits no key at all, so `item_key` is
simply unused there. No special handling, no error, no warning.

### 4. Settings pane

`JsonExportEditor.svelte` keeps its four columns. On a row whose `group` box is
checked, the Key cell renders two stacked inputs with `array` / `item`
micro-labels (`data-testid` `json-key-{i}` and `json-item-key-{i}`); an
unchecked row keeps the single bare input it has today, so the common case does
not change shape.

The item input's placeholder is that row's resolved group key from
`defaultJsonKeys` — literally the fallback it stands for.

The item input is shown whenever `group` is checked, **including** when the
group would currently unwrap and drop the key. Deciding otherwise means
reimplementing `build_group_plan`'s ownership walk in TypeScript, which is the
exact drift the backend-rendered preview pane exists to prevent; the preview
already shows the truth for that table.

`snake_case all` rewrites explicitly-set item keys too. Blank ones stay blank
and keep following the group key, which the button is snaking anyway.

## Testing

- `tests/table/test_json_export.py`
  - split keys render on a nested group (array key at the parent level, item key
    on the entry's own value, member columns untouched);
  - a blank `item_key` produces output identical to the pre-change renderer;
  - an explicit item key colliding with a member column's key gets `_2`, while
    the verbatim-equals-group-key default does not;
  - `item_key` set on an unwrapped group changes nothing;
  - `item_key` set on a non-grouped or hidden column changes nothing.
- `tests/api/test_table_export_json.py` — one round-trip through
  `POST /tables/export` proving the field survives the schema and reaches the
  renderer.
- `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts` — the
  second input appears only on grouped rows, patches `item_key`, and takes its
  placeholder from the resolved group key.
- `frontend/src/lib/table/__tests__/columns.test.ts` — `snake_case all` snakes
  an explicit item key and leaves a blank one blank.

## Out of scope

- Singular/plural inference for the item key default.
- Per-level (rather than global) key namespaces.
- Renaming or restructuring the existing `key` / `value` / `group` fields.
