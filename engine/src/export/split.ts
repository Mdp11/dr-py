/**
 * Per-base-element partitioning and the filename policy for split JSON
 * export, a port of `core/table/split.py`. Pure over row keys — this module
 * sits above the JSON renderer and decides which rows land in which file and
 * what that file is called.
 */
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { PropertyValue } from '../navigation/evaluate.ts';
import type { Binding, RowKey } from '../table/rows.ts';
import { pyStr } from '../value/repr.ts';
import { bucketed, slotKey } from './json.ts';
import { sanitizeStem, substitute } from './naming.ts';

const SPLIT_TOKEN = '${name}';

/** `renderFilenames`'s own guard: the oracle's message when `template` lacks `${name}`, else `null`. */
export function validateTemplate(template: string): string | null {
	return template.includes(SPLIT_TOKEN) ? null : `filename template must contain ${SPLIT_TOKEN}`;
}

/** One partition: its slot-0 binding and the row indices it holds, in first-appearance order. */
export type Partition = { binding: Binding; indices: readonly number[] };

/**
 * The rows bucketed by `RowKey` slot 0 (the base element for a scope or
 * navigation row source, the chain origin for chains), in first-appearance
 * order so the requested sort survives. Buckets key on Python equality —
 * `slotKey`, the same signature `json.ts`'s grouping uses.
 */
export function splitPartitions(keys: readonly RowKey[]): Partition[] {
	const indices = keys.map((_, i) => i);
	return bucketed(indices, (i) => slotKey(keys[i]![0]!)).map((group) => ({
		binding: keys[group[0]!]![0]!,
		indices: group
	}));
}

/**
 * `(fallbackId, name)` for one partition's slot-0 binding: an element id
 * looks itself up (a dangling one degrades to the id itself, the same
 * tolerance as the JSON renderer's), anything else — unreachable for a slot
 * 0, which a row source only ever seeds with an element id — renders through
 * Python's `str()`.
 */
export function partitionLabel(model: Model, binding: Binding): readonly [string, string] {
	if (typeof binding === 'string') {
		const el = model.findElement(binding);
		return el === undefined ? [binding, binding] : [binding, displayName(el)];
	}
	if (binding instanceof PropertyValue) {
		throw new Error('a split partition never keys on a value terminal');
	}
	const text = pyStr(binding);
	return [text, text];
}

/**
 * One filename STEM per `(fallbackId, name)` item, deduplicated `_2`, `_3`,
 * ... in row order. Per-item vars are `name` and `id` (the fallback id);
 * `extra` carries the run-level context tokens (`rev`/`date`/`project`). The
 * extension is the caller's to append after dedup, so a produced `a_2` can
 * never collide with a literal one of the same name.
 */
export function renderFilenames(
	template: string,
	items: readonly (readonly [string, string])[],
	extra: Readonly<Record<string, string>> = {}
): string[] {
	const message = validateTemplate(template);
	if (message !== null) throw new Error(message);
	const taken = new Set<string>();
	const out: string[] = [];
	for (const [fallback, name] of items) {
		const rendered = substitute(template, { ...extra, name, id: fallback });
		const base = sanitizeStem(rendered) || sanitizeStem(fallback) || 'element';
		let candidate = base;
		for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
		taken.add(candidate);
		out.push(candidate);
	}
	return out;
}
