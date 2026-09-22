import { describe, expect, it } from 'vitest';
import { addQuietProbe, quiet } from '../quiet';

describe('quiet', () => {
	it('resolves at once when nothing is registered', async () => {
		await expect(quiet()).resolves.toBeUndefined();
	});

	it('awaits every registered probe', async () => {
		const order: string[] = [];
		const remove1 = addQuietProbe(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push('one');
		});
		const remove2 = addQuietProbe(async () => {
			order.push('two');
		});
		try {
			await quiet();
			expect(order.sort()).toEqual(['one', 'two']);
		} finally {
			remove1();
			remove2();
		}
	});

	it('does not ask a probe that was removed', async () => {
		let asked = false;
		const remove = addQuietProbe(async () => {
			asked = true;
		});
		remove();
		await quiet();
		expect(asked).toBe(false);
	});

	it('removing an already-removed probe is a no-op', async () => {
		let asked = false;
		const remove = addQuietProbe(async () => {
			asked = true;
		});
		remove();
		remove();
		await quiet();
		expect(asked).toBe(false);
	});
});
