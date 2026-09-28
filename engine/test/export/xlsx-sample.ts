/**
 * The engine's workbook for the `export_bytes` case `xlsx_types`: the
 * fixture's model and artifacts set up, then the case's export run. The
 * committed `fixtures/xlsx/sample.xlsx` is these bytes; `npm run xlsx-sample`
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
	type ExportFileResult,
	type MetamodelDoc,
	type ModelOp,
	type ReadParams
} from '../../src/index.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';

export const SAMPLE_CASE = 'xlsx_types';

export const SAMPLE_URL = new URL('../../fixtures/xlsx/sample.xlsx', import.meta.url);

type SetupStep = {
	do: string;
	case?: string;
	ops?: string[];
	artifacts?: { [id: string]: { kind: string; payload: Tagged } };
	body?: ReadParams;
	date?: string;
	method?: string;
};

export function sampleWorkbook(): Uint8Array {
	const fixture = loadFixture<{ metamodel: MetamodelDoc; steps: SetupStep[] }>('export_bytes');
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	const artifacts = new ArtifactSet();
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
		} else if (step.case === SAMPLE_CASE) {
			const result = drain(
				EVALUATIONS[step.method!]!(
					{ model, artifacts, placements: new ViewPlacements() },
					{ ...step.body!, date: step.date!, project: 'p' }
				)
			) as ExportFileResult;
			const bytes = new Uint8Array(result.parts.reduce((n, part) => n + part.byteLength, 0));
			let at = 0;
			for (const part of result.parts) {
				bytes.set(new Uint8Array(part), at);
				at += part.byteLength;
			}
			return bytes;
		}
	}
	throw new Error(`no ${SAMPLE_CASE} case in export_bytes`);
}
