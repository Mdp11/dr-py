import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptHost } from '../../engine/src/script/host.ts';
import {
	fakeWorkers,
	honest,
	settle,
	type Fake
} from '../../engine/test/script/fixtures/fake-workers.ts';
import type { CspViolation } from '../src/handshake.ts';
import { createBrowserHost, violationRelay } from '../src/script-host.ts';

// What the browser port adds to the engine's pool: how it is sized, and how a script worker's
// violations reach the page. The pool itself, over real Pyodide, is proved in the engine's tests and
// in Chromium by `pixi run engine-scripts-browser`; the spawner and `script-worker.ts` need a browser.

const hosts: ScriptHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.dispose()));

function hostOf(parallelism: number | undefined, post: (violation: CspViolation) => void) {
	const fakes = fakeWorkers(honest);
	const warnings: string[] = [];
	const host = createBrowserHost({
		spawn: fakes.spawn,
		post,
		parallelism,
		warn: (message) => warnings.push(message)
	});
	hosts.push(host);
	return { host, fakes, warnings };
}

const batch = (n: number) => ({
	code: 'def value(els):\n    return 1\n',
	entry: 'value' as const,
	calls: Array.from({ length: n }, () => ({ elementIds: [] }))
});

describe('violationRelay', () => {
	it('posts the violation as the page expects it', () => {
		const posted: CspViolation[] = [];
		violationRelay((violation) => posted.push(violation))({
			directive: 'script-src',
			blocked: 'eval'
		});
		expect(posted).toEqual([{ type: 'csp-violation', directive: 'script-src', blocked: 'eval' }]);
	});

	it('cuts what a forged report makes long', () => {
		const posted: CspViolation[] = [];
		violationRelay((violation) => posted.push(violation))({
			directive: 'd'.repeat(10_000),
			blocked: 'b'.repeat(10_000_000)
		});
		expect(posted[0]!.directive).toHaveLength(256);
		expect(posted[0]!.blocked).toHaveLength(256);
	});

	it('never throws into its caller when the post does', () => {
		const relay = violationRelay(() => {
			throw new Error('the port is closed');
		});
		expect(() => relay({ directive: 'script-src', blocked: 'eval' })).not.toThrow();
	});
});

describe('the browser host', () => {
	it('relays a violation a worker reports, and survives a post that throws', async () => {
		let posted = 0;
		const { host, fakes } = hostOf(4, () => {
			posted++;
			throw new Error('the port is closed');
		});
		host.prewarm();
		await settle(20);
		const first = fakes.fakes[0]!;
		first.say({ type: 'csp-violation', directive: 'script-src', blocked: 'eval' });
		first.say({ type: 'csp-violation', directive: 'connect-src', blocked: 'https://x.test/' });
		await settle(50);
		expect(posted).toBe(2);
		// The worker the violation came from is still the pool's: it boots and a run reaches it.
		const run = await host.run(batch(2), { dispatch: () => '', roots: () => '[]' });
		expect(run.results.map((one) => one.text)).toEqual(['r0', 'r1']);
	});

	it('drops a violation whose fields are not strings', async () => {
		const posted: CspViolation[] = [];
		const { host, fakes } = hostOf(4, (violation) => posted.push(violation));
		host.prewarm();
		await settle(20);
		fakes.fakes[0]!.say({ type: 'csp-violation', directive: 1, blocked: {} });
		await settle(50);
		expect(posted).toEqual([]);
	});

	it('is sized by the cores the browser reports, one when it reports none', async () => {
		// Workers that boot and hold their batch: the runs started are the cap.
		const holding = (fake: Fake, message: { type?: unknown }) => {
			if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
		};
		for (const [parallelism, cap] of [
			[8, 4],
			[5, 3],
			[3, 1],
			[undefined, 1],
			[0, 1]
		] as const) {
			const fakes = fakeWorkers(holding);
			const host = createBrowserHost({
				spawn: fakes.spawn,
				post: () => {},
				parallelism,
				warn: () => {}
			});
			hosts.push(host);
			const bridge = { dispatch: () => '', roots: () => '[]' };
			for (let i = 0; i < 6; i++) void host.run(batch(1), bridge).catch(() => {});
			await settle(150);
			const started = fakes.fakes.filter((fake) => fake.posted.some((m) => m.type === 'run'));
			expect(started, `parallelism ${parallelism}`).toHaveLength(cap);
			host.dispose();
		}
	});
});
