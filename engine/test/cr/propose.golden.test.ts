import { describe, expect, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, withExactCrs, type StepsFixture } from '../golden/model-steps.ts';

describe('POST /model/apply-cr, over the working copy', () => {
	const fixture = withExactCrs(loadFixture<StepsFixture>('change_request'), 'change_request');

	it('holds proposals of every kind, fallbacks and staged ones included', () => {
		const proposals = fixture.steps.filter((step) => step.do === 'apply_cr');
		expect(proposals.length).toBeGreaterThan(25);
		expect(proposals.some((step) => step.fallback === true)).toBe(true);
		expect(proposals.some((step) => step.stage !== undefined)).toBe(true);
	});

	it('answers as the route does: the proposal, the conflict, the refusal, or the fallback', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
