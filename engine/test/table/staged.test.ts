import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	ArtifactSet,
	drain,
	evaluateTable,
	Metamodel,
	Model,
	ReadError,
	ViewPlacements,
	type CommittedArtifact,
	type Props,
	type ReadParams,
	type StagedArtifact
} from '../../src/index.ts';
import { loadFixture, untag } from '../golden/load.ts';
import { parseOps, replaySteps, type Step, type StepsFixture } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';

type Payload = CommittedArtifact['payload'];

const fixture = loadFixture<StepsFixture>('table_eval');

/** The fixture's model: its batches, landed with the oracle's ids, and what it inserts. */
function fixtureModel(): Model {
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	let minted = 0;
	for (const step of fixture.steps) {
		if (step.do === 'batch') {
			applyBatch(model, parseOps(step.ops!), { idFor: () => `id-${++minted}` });
		} else if (step.do === 'insert_element') {
			model.insertElement(step.id!, step.type!, untag(step.value!) as Props, step.rev!);
		}
	}
	return model;
}

/** The fixture's artifacts, by id. */
const payloads: { [id: string]: { kind: string; payload: Payload } } = Object.fromEntries(
	Object.entries(fixture.steps.find((s) => s.do === 'artifacts')!.artifacts!).map(
		([id, { kind, payload }]) => [id, { kind, payload: untag(payload) as Payload }]
	)
);

function committed(): ArtifactSet {
	const artifacts = new ArtifactSet();
	artifacts.setCommitted(
		Object.entries(payloads).map(([id, { kind, payload }]) => ({
			id,
			kind,
			name: id,
			rev: 1,
			payload
		}))
	);
	return artifacts;
}

/** The body the oracle recorded for a saved table read with no page params. */
function recorded(artifactId: string): string {
	const step = fixture.steps.find(
		(s: Step) =>
			s.do === 'read' &&
			s.params?.['artifact_id'] === artifactId &&
			Object.keys(s.params).length === 1
	)!;
	return JSON.stringify(step.result);
}

const model = fixtureModel();

const evaluate = (artifacts: ArtifactSet, params: ReadParams) =>
	JSON.stringify(
		drain(evaluateTable({ model, artifacts, placements: new ViewPlacements() }, params))
	);

describe('staged artifacts', () => {
	it('answer every call of the fixture as committed ones do', () => {
		replaySteps(fixture, {}, 'staged');
	});

	it('evaluate a staged table by id: a create and an update of a committed one', () => {
		const artifacts = committed();
		const staged: StagedArtifact[] = [
			{ op: 'create', id: 'tmp_t', kind: 'table', name: 'T', payload: payloads['t1e']!.payload },
			{ op: 'update', id: 't1', payload: payloads['t1e']!.payload }
		];
		artifacts.setStaged(staged);
		expect(evaluate(artifacts, { artifact_id: 'tmp_t' })).toBe(recorded('t1e'));
		expect(evaluate(artifacts, { artifact_id: 't1' })).toBe(recorded('t1e'));
		artifacts.setStaged([]);
		expect(evaluate(artifacts, { artifact_id: 't1' })).toBe(recorded('t1'));
	});

	it('evaluate a committed table through a staged navigation it names', () => {
		const artifacts = committed();
		expect(evaluate(artifacts, { artifact_id: 't1' })).toBe(recorded('t1'));
		artifacts.setStaged([{ op: 'update', id: 'nr', payload: payloads['ne']!.payload }]);
		expect(evaluate(artifacts, { artifact_id: 't1' })).toBe(recorded('t1e'));
	});

	it('refuse a table whose navigation a staged delete hides, as a dangling ref', () => {
		const artifacts = committed();
		artifacts.setStaged([{ op: 'delete', id: 'nr' }]);
		const error = thrown(() =>
			evaluateTable({ model, artifacts, placements: new ViewPlacements() }, { artifact_id: 't1' })
		);
		expect(error).toBeInstanceOf(ReadError);
		// The oracle's text for t2, whose navigation is missing: `unknown artifact nope`.
		expect(error).toMatchObject({ status: 422, detail: 'unknown artifact nr' });
		artifacts.setStaged([{ op: 'delete', id: 't1' }]);
		expect(
			thrown(() =>
				evaluateTable({ model, artifacts, placements: new ViewPlacements() }, { artifact_id: 't1' })
			)
		).toMatchObject({ status: 422, detail: 'unknown artifact t1' });
	});
});
