import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe("a view's warnings as GET /views/{id} answers them", () => {
	const fixture = loadFixture<StepsFixture>('view_warnings');

	it('over committed artifacts, with and without ops staged', () => {
		replaySteps(fixture);
	});

	it('over staged artifacts', () => {
		replaySteps(fixture, {}, 'staged');
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
