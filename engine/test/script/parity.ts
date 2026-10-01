import { expect } from 'vitest';
import {
	dumpDefault,
	parseExact,
	projectRoots,
	type Model,
	type RawScriptResult,
	type ScriptBatch,
	type ScriptEntry,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';

export type ParityCall = { element_ids: string[]; inputs_text?: string; doc_text?: string };

/** One case of `script_parity.json`: what the oracle's harness answered to `calls` over `parityModel()`. */
export type ParityCase = {
	name: string;
	group: string;
	mode: 'embedded' | 'console';
	entry: ScriptEntry;
	code: string;
	calls: ParityCall[];
	/** One result text per call. */
	results: string[];
	/** The dispatcher's recorded ops as text, on every console `script` case. */
	ops?: string;
};

type ParityFile = {
	model: {
		metamodel: Parameters<typeof loadLines>[0];
		elements: string[];
		relationships: string[];
	};
	cases: ParityCase[];
};

const file = loadFixture<ParityFile>('script_parity');

export function loadParity(): ParityCase[] {
	return file.cases;
}

let model: Model | undefined;

/** The corpus's model. Scripts only read it, so one copy serves every case. */
export function parityModel(): Model {
	model ??= loadLines(file.model.metamodel, file.model.elements, file.model.relationships);
	return model;
}

/** The case as a batch: inputs and documents parsed exactly, so `1.0` stays a float. */
export function parityBatch(c: ParityCase): ScriptBatch {
	return {
		code: c.code,
		entry: c.entry,
		...(c.mode === 'console' && { console: true }),
		calls: c.calls.map((call) => ({
			elementIds: call.element_ids,
			...(call.inputs_text !== undefined && { inputs: parseExact(call.inputs_text) }),
			...(call.doc_text !== undefined && { doc: parseExact(call.doc_text) })
		}))
	};
}

/** The elements an input names, in the order it lists them. */
function inputElementIds(inputs: Value | undefined): string[] {
	if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return [];
	const ids: string[] = [];
	for (const spec of Object.values(inputs)) {
		const s = spec as { kind?: Value; ids?: Value };
		if (s.kind === 'elements' && Array.isArray(s.ids)) ids.push(...(s.ids as string[]));
	}
	return ids;
}

/**
 * Each call's roots text, as the oracle primed the facade: the call's elements and its input
 * elements, once each; none for a document.
 */
export function parityRoots(c: ParityCase, batch: ScriptBatch = parityBatch(c)): string[] {
	return batch.calls.map((call) =>
		batch.entry === 'transform'
			? '[]'
			: dumpDefault(
					projectRoots(parityModel(), [
						...new Set([...call.elementIds, ...inputElementIds(call.inputs)])
					])
				)
	);
}

/** Holds a run of `c` to the oracle's bytes; `ops` is the recording dispatcher's ops as text. */
export function expectParity(c: ParityCase, results: readonly RawScriptResult[], ops?: string) {
	expect(
		results.map((r) => r.text),
		c.name
	).toEqual(c.results);
	if (c.ops !== undefined) expect(ops, `${c.name}: ops`).toBe(c.ops);
}
