import { describe, expect, it } from 'vitest';
import {
	candidateDiff,
	candidateScan,
	compileRuleSets,
	drain,
	LiveIssues,
	prepareCandidate,
	ruleSources,
	type CandidateDiff,
	type Metamodel,
	type ModelOptions
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import {
	comparableDiff,
	loadModelFile,
	parseOps,
	replaySteps,
	rulesArtifacts,
	type ArtifactLayer,
	type StepsFixture
} from '../golden/model-steps.ts';
import { workingCopy } from '../working/helpers.ts';

/**
 * The run with its batch STAGED on a working copy rather than applied, its
 * rule set in `rules`' layer, the store swept on the committed state before
 * the batch lands in it: each candidate diffs that store against the working
 * state scanned under the document, the working rule sources recompiled for it.
 */
function replayStaged(run: StepsFixture, options: ModelOptions, rules: ArtifactLayer): void {
	const [rulesStep, batchStep, seedStep, ...candidates] = run.steps;
	expect([rulesStep!.do, batchStep!.do, seedStep!.do]).toEqual(['rules', 'batch', 'seed']);
	const set = rulesArtifacts(rulesStep!, rules);
	const compile = (layer: 'working' | 'committed', mm: Metamodel) =>
		compileRuleSets(ruleSources(set, layer), mm);
	const model = loadModelFile(run, options);
	const live = new LiveIssues(workingCopy(model), {
		rules: {
			working: compile('working', model.metamodel),
			committed: compile('committed', model.metamodel)
		}
	});
	expect(live.rules.working.total).toBe(2);
	expect(live.rules.committed.total).toBe(rules === 'committed' ? 2 : 0);
	drain(live.sweepSteps());
	live.stage(parseOps(batchStep!.ops!));
	expect(live.settled).toBe(true);
	expect(live.wc.staged()).toHaveLength(1);
	expect(candidates.length).toBeGreaterThan(0);
	for (const step of candidates) {
		expect(step.do).toBe('candidate');
		const candidate = prepareCandidate(step.metamodel, (mm) => compile('working', mm));
		const issues = drain(candidateScan(live.wc.model, candidate));
		const diff = comparableDiff(candidateDiff(live.store.iter(), issues));
		expect(JSON.stringify(diff), step.case).toBe(
			JSON.stringify(comparableDiff(step.result as CandidateDiff))
		);
	}
}

describe('a candidate metamodel diffs as the oracle diffs it', () => {
	const [diffs, previews] = loadFixture<{ runs: StepsFixture[] }>('metamodel_candidate').runs;
	const hashes: [string, ModelOptions][] = [
		['', {}],
		[', every uniqueness key in one bucket', { hashKey: () => 0 }]
	];

	for (const [label, options] of hashes) {
		it(`over the session's store, the batch landed${label}`, () => {
			replaySteps(diffs!, options);
		});

		it(`over the working copy, the batch staged${label}`, () => {
			replayStaged(diffs!, options, 'committed');
		});

		it(`over the working copy, the batch and the rule set staged${label}`, () => {
			replayStaged(diffs!, options, 'staged');
		});

		it(`previews a rebind over staged ops as the oracle does${label}`, () => {
			expect(previews!.steps.filter((step) => step.do === 'preview_rebind')).toHaveLength(4);
			replaySteps(previews!, options);
		});
	}
});
