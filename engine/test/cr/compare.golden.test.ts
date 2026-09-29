import { describe, expect, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('POST /model/compare, over the working copy', () => {
	const fixture = loadFixture<StepsFixture>('change_request');
	// The apply-CR steps come last and change nothing: the compare replay leaves them out.
	const proposals = fixture.steps.filter((step) => step.do === 'apply_cr');
	const compares: StepsFixture = {
		...fixture,
		steps: fixture.steps.filter((step) => step.do !== 'apply_cr')
	};

	it('leaves out only apply-CR steps that change nothing, after every compare', () => {
		expect(proposals.every((step) => step.unchanged === true)).toBe(true);
		const firstProposal = fixture.steps.findIndex((step) => step.do === 'apply_cr');
		expect(fixture.steps.slice(firstProposal).every((step) => step.do === 'apply_cr')).toBe(true);
		expect(compares.steps.filter((step) => step.do === 'compare').length).toBeGreaterThan(40);
	});

	it('answers as the route does, refusals and fallbacks included', () => {
		replaySteps(compares);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(compares, { hashKey: () => 0 });
	});
});
