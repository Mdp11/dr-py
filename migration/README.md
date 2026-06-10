# Legacy format migration

Migrates an old-format metamodel + model pair to the new format.

## Usage

```bash
PYTHONPATH=src python -m data_rover.migration \
  --old-metamodel old.metamodel.json \
  --old-model     old.model.json \
  --out-metamodel new.metamodel.yaml \
  --out-model     new.model.json \
  [--emit-unmapped-links]
```

It always writes both outputs and prints a report (migration warnings,
metamodel `check_metamodel` errors, model validation issues). It never raises on
an invalid result, so referentially-incomplete inputs still produce inspectable
output. The provided `*_sample.json` files are intentionally incomplete (the
sample relationship maps endpoints that aren't declared element types), so the
report flags those — that is expected for the samples, not the migration logic.

## Mapping rules

### Model (instance data)
- `elements`/`relationships` dicts → arrays; each gets `rev: 0`, top-level `rev: 1`.
- `stereotype` → `type_name`; `source`/`destination` → `source_id`/`target_id`.
- `SourceDatabase` and `debug_data` are dropped from every element/relationship.
- top-level `metadata` (`release`/`commit`) is dropped.
- `owner` → an **`Owns`** containment relationship (`owner` is the container/source,
  the element is the target).
- `element_type` → a **`TypedBy`** non-containment relationship (the element is the
  source, its type element the target).
- Synthesized `Owns`/`TypedBy` ids are deterministic (re-runs are idempotent).

### Metamodel
- Each stereotype → an element type. `id_properties` → `key` (and those properties
  get multiplicity `1`). Properties are the union of `id_properties`,
  `other_properties`, and any property observed in the model data.
- Property **datatypes** are inferred from the real model values
  (int→integer, float→float, bool→boolean, ISO `YYYY-MM-DD`→date, else string).
- Property **multiplicity**: id properties `1`; list-valued in data `0..*`; else `0..1`.
- Each old relationship → a relationship type whose `mappings` come from the old
  `mappings` (`source`/`destination` pairs). The new metamodel supports multiple
  `(source, target)` mappings per relationship type.
- `Owns`/`TypedBy` allowed `mappings` are derived **only** from the old metamodel's
  `is_owned_by_one_of` / `is_typed_by_one_of` constraints. A model link whose
  stereotype pair isn't permitted is **skipped and warned** (use
  `--emit-unmapped-links` to emit anyway). If a constraint list is empty, that
  synthesized type is not created.
