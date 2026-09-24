import { describe, expect, it } from 'vitest';
import { createEngineSeam } from '../seam';
import { SURFACE_DEFAULTS } from '../surfaces';
import { OFF, type ReplicaStatus } from '../sync';

/** A sync whose status is `status.current`; the seam's `side` never calls it. */
function statusOnly(status: { current: ReplicaStatus }) {
	return {
		status: () => status.current,
		call: <T>(): Promise<T> => Promise.reject(new Error('not called'))
	};
}

describe('the engine seam', () => {
	it('a closed gate puts its surface on the server, and only that one', () => {
		const status = { current: { ...OFF, phase: 'ready', rev: 0 } as ReplicaStatus };
		let open = false;
		const seam = createEngineSeam(statusOnly(status), SURFACE_DEFAULTS, undefined, {
			navigation: () => open
		});

		expect(seam.side('navigation')).toBe('server');
		expect(seam.side('criteria')).toBe('engine');
		expect(seam.side('elements')).toBe('engine');

		open = true;
		expect(seam.side('navigation')).toBe('engine');

		status.current = OFF;
		expect(seam.side('navigation')).toBe('server');
	});

	it('an open gate does not override a surface switched to the server', () => {
		const status = { current: { ...OFF, phase: 'ready', rev: 0 } as ReplicaStatus };
		const seam = createEngineSeam(
			statusOnly(status),
			{ ...SURFACE_DEFAULTS, navigation: 'server' },
			undefined,
			{ navigation: () => true }
		);

		expect(seam.side('navigation')).toBe('server');
	});
});
