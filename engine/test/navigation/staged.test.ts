import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	evaluateNavigation,
	ReadError,
	ViewPlacements,
	type ChainPageOut,
	type CommittedArtifact,
	type ReadParams,
	type StagedArtifact
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';

type Payload = CommittedArtifact['payload'];

const path = (types: string[], ...steps: object[]) => ({
	kind: 'path',
	start: { kind: 'scope', types },
	steps
});
const hop = (type: string) => ({ kind: 'relationship', relationship_type: type });
const union = (...operands: object[]) => ({ kind: 'set_op', op: 'union', operands });

/** The ids a page's chains hold, one string per chain. */
const ids = (page: ChainPageOut) =>
	page.chains.map((chain) => chain.map((node) => ('id' in node ? node.id : '?')).join(' '));

function evaluate(artifacts: ArtifactSet, params: ReadParams): ChainPageOut {
	return drain(
		evaluateNavigation({ model: family(), artifacts, placements: new ViewPlacements() }, params)
	);
}

describe('staged artifacts', () => {
	it('answer every call of the fixture as committed ones do', () => {
		replaySteps(loadFixture<StepsFixture>('nav_eval'), {}, 'staged');
	});

	it('resolve a staged navigation that names another staged one', () => {
		const artifacts = new ArtifactSet();
		const staged: StagedArtifact[] = [
			{
				op: 'create',
				id: 'tmp_b',
				kind: 'navigation',
				name: 'B',
				payload: path(['Node'], hop('Refers')) as Payload
			},
			{
				op: 'create',
				id: 'tmp_a',
				kind: 'navigation',
				name: 'A',
				payload: union({ ref: 'tmp_b', step_index: 1 }) as Payload
			}
		];
		artifacts.setStaged(staged);
		expect(ids(evaluate(artifacts, { artifact_id: 'tmp_a' }))).toEqual(['c']);
		expect(
			ids(evaluate(artifacts, { definition: union({ ref: 'tmp_b', step_index: 0 }) }))
		).toEqual(['a']);

		// Deleted in the buffer, the navigation it names is as missing as an unknown ref.
		artifacts.setStaged([staged[1]!, { op: 'delete', id: 'tmp_b' }]);
		const error = thrown(() =>
			evaluateNavigation(
				{ model: family(), artifacts, placements: new ViewPlacements() },
				{ artifact_id: 'tmp_a' }
			)
		);
		expect(error).toBeInstanceOf(ReadError);
		expect(error).toMatchObject({ status: 422, detail: "unknown navigation artifact 'tmp_b'" });
	});

	it('evaluate a staged update of a committed navigation, by id and by ref', () => {
		const artifacts = new ArtifactSet();
		artifacts.setCommitted([
			{
				id: 'n1',
				kind: 'navigation',
				name: 'N',
				rev: 3,
				payload: path(['Node'], hop('Contains')) as Payload
			}
		]);
		expect(ids(evaluate(artifacts, { artifact_id: 'n1' }))).toEqual(['a b', 'b d']);
		artifacts.setStaged([
			{ op: 'update', id: 'n1', payload: path(['Node'], hop('Refers')) as Payload }
		]);
		expect(ids(evaluate(artifacts, { artifact_id: 'n1' }))).toEqual(['a c']);
		expect(ids(evaluate(artifacts, { definition: union({ ref: 'n1' }) }))).toEqual(['c']);
		// A name-only update keeps the committed payload.
		artifacts.setStaged([{ op: 'update', id: 'n1', name: 'renamed' }]);
		expect(ids(evaluate(artifacts, { artifact_id: 'n1' }))).toEqual(['a b', 'b d']);
	});
});
