import { afterAll, describe, expect, it } from 'vitest';
import type { ScriptHost } from '../../src/index.ts';
import { nodeScriptHost } from '../../node/script-host.ts';
import { loadFixture } from '../golden/load.ts';
import { type StepsFixture } from '../golden/model-steps.ts';
import { replayScripted } from '../golden/scripted-steps.ts';

// The exports and transform previews of `export_bytes` that run snippets, answered by the oracle on its trusted runner
// and run again here by the fill loop over real Pyodide in worker threads.

const hosts: ScriptHost[] = [];
afterAll(() => hosts.forEach((host) => host.dispose()));

const fixture = loadFixture<StepsFixture>('export_bytes');

/** The fixture's model, artifact and bulk batches, and its `script_*` cases. */
const scripted: StepsFixture = {
	...fixture,
	steps: fixture.steps.filter((step) => step.case === undefined || step.case.startsWith('script_'))
};

describe('exports and transform previews that run snippets answer as the oracle answers', () => {
	it('holds every scripted case', () => {
		const cases = scripted.steps.filter((step) => step.case !== undefined);
		expect(cases).toHaveLength(95);
		expect(cases.filter((step) => step.method === 'previewTransform')).toHaveLength(40);
	});

	it.each(['committed', 'staged'] as const)(
		'every script cell, transform, refusal and preview, artifacts %s',
		async (layer) => {
			const host = nodeScriptHost();
			hosts.push(host);
			await replayScripted(scripted, host, layer);
		},
		600_000
	);
});
