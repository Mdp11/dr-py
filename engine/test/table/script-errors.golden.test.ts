import { afterAll, describe, it } from 'vitest';
import type { ScriptHost } from '../../src/index.ts';
import { cappedNodeScriptHost } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { type StepsFixture } from '../golden/model-steps.ts';
import { replayScripted } from '../golden/scripted-steps.ts';

// The recap of a table's script errors, as the oracle answered it on its trusted runner, over the
// fill loop and real Pyodide in worker threads.

// Two workers: these replays run beside vitest's other files, and the boots, not the calls, cost the CPU.
const GOLDEN_WORKERS = 2;

const hosts: ScriptHost[] = [];
afterAll(() => hosts.forEach((host) => host.dispose()));

describe('the script-error recap answers as the oracle answers', () => {
	const fixture = loadFixture<StepsFixture>('table_script_errors');

	it.each(['committed', 'staged'] as const)(
		'no errors, errors in two columns, a sort, the cap, an expand column and ignored paging, artifacts %s',
		async (layer) => {
			const host = cappedNodeScriptHost(GOLDEN_WORKERS)();
			hosts.push(host);
			await replayScripted(fixture, host, layer);
		},
		300_000
	);
});
