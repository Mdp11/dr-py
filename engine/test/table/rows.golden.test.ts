import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('table rows build and order as the core builds and orders them', () => {
	const fixture = loadFixture<StepsFixture>('table_rows');

	it('every row source, column kind and mode, row cap and sort', () => {
		replaySteps(fixture);
	});

	it('the same over staged artifacts', () => {
		replaySteps(fixture, {}, 'staged');
	});
});
