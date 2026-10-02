import { afterAll, describe, it } from 'vitest';
import type { ScriptHost } from '../../src/index.ts';
import { nodeScriptHost } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { type StepsFixture } from '../golden/model-steps.ts';
import { replayScripted } from '../golden/scripted-steps.ts';

// The script columns and script steps of tables the oracle ran on its trusted runner, run again here by the fill loop over
// real Pyodide in worker threads.

const hosts: ScriptHost[] = [];
afterAll(() => hosts.forEach((host) => host.dispose()));

describe('tables with scripts answer as the oracle answers', () => {
	const fixture = loadFixture<StepsFixture>('table_eval_scripted');

	it.each(['committed', 'staged'] as const)(
		'every column kind, input, failure, sort, row source, snippet ref and preview, artifacts %s',
		async (layer) => {
			const host = nodeScriptHost();
			hosts.push(host);
			await replayScripted(fixture, host, layer);
		},
		300_000
	);
});
