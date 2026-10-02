import {
	drain,
	evaluateFilled,
	EVALUATIONS,
	type BatchRunner,
	type EvalContext,
	type ReadParams,
	type ScriptHost
} from '../../src/index.ts';
import { BridgeDispatcher, dumpDefault, projectRoots } from '../../src/script/bridge.ts';

/** An evaluation run to its end over a real script host, the scripts reading the context's model. */
export async function filled<T>(
	host: ScriptHost,
	ctx: Omit<EvalContext, 'scripts'>,
	method: string,
	params: ReadParams
): Promise<T> {
	const { model } = ctx;
	const dispatcher = new BridgeDispatcher(model, false);
	const bridge = {
		dispatch: (text: string) => dispatcher.dispatch(text),
		roots: (ids: string[]) => dumpDefault(projectRoots(model, ids))
	};
	const runner: BatchRunner = async (batch, signal) => {
		const run = await host.run(batch, bridge, signal);
		return run.results.map((one) => one.text);
	};
	const { value } = await evaluateFilled(
		async (scripts) => drain(EVALUATIONS[method]!({ ...ctx, scripts }, params)),
		{ runner, signal: new AbortController().signal }
	);
	return value as T;
}
