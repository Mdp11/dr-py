// Component and store tests that need the model reads' answers, not an
// engine: a seam whose `call` answers each method from `answers`. The reads'
// own behaviour against the real engine is `engine-reads.test.ts`.
import { installEngineSeam } from '../engine-route';

type Answers = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test knows its method's params
	[method: string]: (params: any, signal?: AbortSignal) => unknown;
};

/** Installs the seam; `calls` lists what the engine was asked, in order. Remove it with `installEngineSeam(null)`. */
export function stubEngine(answers: Answers) {
	const calls: { method: string; params: unknown }[] = [];
	installEngineSeam({
		call: <T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
			calls.push({ method, params });
			const answer = answers[method];
			if (answer === undefined) return Promise.reject(new Error(`no answer for ${method}`));
			try {
				return Promise.resolve(answer(params, signal) as T);
			} catch (error) {
				return Promise.reject(error);
			}
		},
		whenReady: () => Promise.resolve()
	});
	return { calls };
}
