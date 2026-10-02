import { afterAll, describe, it } from 'vitest';
import type { ScriptHost } from '../../src/index.ts';
import { cappedNodeScriptHost } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { type StepsFixture } from '../golden/model-steps.ts';
import { replayScripted } from '../golden/scripted-steps.ts';

// The script steps the oracle ran on its trusted runner, run again here by the fill loop over
// real Pyodide in worker threads.

// Two workers: these replays run beside vitest's other files, and the boots, not the calls, cost the CPU.
const GOLDEN_WORKERS = 2;

const hosts: ScriptHost[] = [];
afterAll(() => hosts.forEach((host) => host.dispose()));

describe('script steps answer as the oracle answers', () => {
	const fixture = loadFixture<StepsFixture>('nav_eval_scripted');

	it.each(['committed', 'staged'] as const)(
		'every hop, value, failure, ref, set operand and row start, artifacts %s',
		async (layer) => {
			const host = cappedNodeScriptHost(GOLDEN_WORKERS)();
			hosts.push(host);
			await replayScripted(fixture, host, layer);
		},
		300_000
	);
});
