import {
	drain,
	evaluateFilled,
	EVALUATIONS,
	type BatchRunner,
	type Model,
	type ReadParams,
	type ScriptHost
} from '../../src/index.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';
import type { Bridge } from '../../src/script/host.ts';
import {
	startReplay,
	type ArtifactLayer,
	type Replay,
	type Step,
	type StepsFixture
} from './model-steps.ts';

/** What the oracle's session caps a call's output at, in characters. */
const STDOUT_CHARS = 256 * 1024;

/** A read-only bridge over `model`, as it stands when the batch starts. */
function bridgeOver(model: Model): Bridge {
	const dispatcher = new BridgeDispatcher(model, false);
	return {
		dispatch: (text) => dispatcher.dispatch(text),
		roots: (ids) => dumpDefault(projectRoots(model, ids))
	};
}

/** A runner that runs each batch on `host` against the model. */
function runnerOver(host: ScriptHost, model: Model): BatchRunner {
	return async (batch, signal) => {
		const run = await host.run(batch, bridgeOver(model), signal);
		return run.results.map((one) => one.text);
	};
}

/** Where the oracle does not record an answer: how a sweep is going, how long a call took. */
const VOLATILE = new Set(['script_status', 'duration_ms']);

function withoutVolatile(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(withoutVolatile);
	if (typeof node !== 'object' || node === null) return node;
	if (Object.getPrototypeOf(node) !== Object.prototype) return node;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => !VOLATILE.has(key))
			.map(([key, item]) => [key, withoutVolatile(item)])
	);
}

/** A scripted `read`: the evaluation run by fill until a pass holds no miss. */
async function readScripted(replay: Replay, step: Step, host: ScriptHost): Promise<unknown> {
	if (step.do !== 'read') throw new Error(`a scripted ${step.do} step is not replayed yet`);
	const method = step.method!;
	if (!Object.hasOwn(EVALUATIONS, method)) throw new Error(`no evaluation ${method}`);
	const params: ReadParams = step.params ?? {};
	const { model, carried } = replay;
	const base = { model, artifacts: carried.artifacts, placements: carried.placements };
	const { value } = await evaluateFilled(
		(scripts) => Promise.resolve(drain(EVALUATIONS[method]!({ ...base, scripts }, params))),
		{
			runner: runnerOver(host, model),
			signal: new AbortController().signal,
			stdoutChars: STDOUT_CHARS
		}
	);
	return withoutVolatile(value);
}

/**
 * The async twin of `replaySteps`: a `scripted` step is answered by running its
 * evaluation to a fill, its snippets run on `host`, and compared as the oracle
 * recorded it; every other step is replayed as `replaySteps` replays it.
 */
export async function replayScripted(
	fixture: StepsFixture,
	host: ScriptHost,
	layer: ArtifactLayer = 'committed'
): Promise<void> {
	const replay = startReplay(fixture, {}, layer);
	for (const [index, step] of fixture.steps.entries()) {
		const label = replay.begin(step, index);
		let result: unknown = null;
		let error: Step['error'] = null;
		try {
			result =
				step.scripted === true ? await readScripted(replay, step, host) : replay.apply(step, index);
		} catch (caught) {
			error = replay.fail(caught);
		}
		replay.end(step, label, result, error);
	}
}
