/**
 * The `export_bytes` fixture's model and committed artifacts set up for an
 * export test, and the engine's workbook for its case `xlsx_types`. The
 * committed `fixtures/xlsx/sample.xlsx` is those bytes; `npm run xlsx-sample`
 * rewrites it. No vitest here: the script imports this module too.
 */
import {
	applyBatch,
	ArtifactSet,
	drain,
	EVALUATIONS,
	Metamodel,
	Model,
	parseJson,
	ViewPlacements,
	type CommittedArtifact,
	type EvalContext,
	type ExportFileResult,
	type MetamodelDoc,
	type ModelOp,
	type ReadParams
} from '../../src/index.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';
import { NO_SCRIPTS } from '../../src/evaluate/fill.ts';

export const SAMPLE_CASE = 'xlsx_types';

export const SAMPLE_URL = new URL('../../fixtures/xlsx/sample.xlsx', import.meta.url);

/** A recorded step, as far as setting up and calling an export reads it. */
export type SetupStep = {
	do: string;
	case?: string;
	ops?: string[];
	artifacts?: { [id: string]: { kind: string; payload: Tagged } };
	body?: ReadParams;
	params?: ReadParams;
	date?: string;
	method?: string;
};

/**
 * The fixture's model after its batches, its artifacts committed under their
 * own ids and names, and its recorded cases in order.
 */
export function exportFixture(): { ctx: EvalContext; cases: SetupStep[] } {
	const fixture = loadFixture<{ metamodel: MetamodelDoc; steps: SetupStep[] }>('export_bytes');
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	const artifacts = new ArtifactSet();
	const cases: SetupStep[] = [];
	let minted = 0;
	for (const step of fixture.steps) {
		if (step.do === 'batch') {
			const ops = step.ops!.map((line) => parseJson(line) as unknown as ModelOp);
			applyBatch(model, ops, { idFor: () => `id-${++minted}` });
		} else if (step.do === 'artifacts') {
			artifacts.setCommitted(
				Object.entries(step.artifacts!).map(([id, { kind, payload }]) => ({
					id,
					kind,
					name: id,
					rev: 1,
					payload: untag(payload) as CommittedArtifact['payload']
				}))
			);
		} else if (step.case !== undefined) cases.push(step);
	}
	return {
		ctx: { model, artifacts, placements: new ViewPlacements(), scripts: NO_SCRIPTS },
		cases
	};
}

/** A shipped file's parts, joined. */
export function joinedParts(result: ExportFileResult): Uint8Array {
	const bytes = new Uint8Array(result.parts.reduce((n, part) => n + part.byteLength, 0));
	let at = 0;
	for (const part of result.parts) {
		bytes.set(new Uint8Array(part), at);
		at += part.byteLength;
	}
	return bytes;
}

export function sampleWorkbook(): Uint8Array {
	const { ctx, cases } = exportFixture();
	const step = cases.find((c) => c.case === SAMPLE_CASE);
	if (step === undefined) throw new Error(`no ${SAMPLE_CASE} case in export_bytes`);
	const result = drain(
		EVALUATIONS[step.method!]!(ctx, { ...step.body!, date: step.date!, project: 'p' })
	) as ExportFileResult;
	return joinedParts(result);
}
