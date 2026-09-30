import { dumpDefault } from './bridge.ts';
import type { RawScriptResult, ScriptBatch } from './host.ts';

/** What the harness calls an error's `kind`; a host writes the ones the harness cannot know. */
export type HostErrorKind = 'runtime' | 'timeout' | 'cancelled' | 'memory';

/**
 * A call the host failed, as the JSON text the harness would have written for it: an embedded
 * call answers `{payload, error, reads, stdout}` and a console run `{stdout, result_repr,
 * truncated, error}`, the error being `{kind, message, traceback}`.
 */
export function hostErrorText(batch: ScriptBatch, kind: HostErrorKind, message: string): string {
	const error = { kind, message, traceback: null };
	const consoleRun = batch.console === true || batch.entry === 'script';
	return dumpDefault(
		consoleRun
			? { stdout: '', result_repr: null, truncated: false, error }
			: { payload: null, error, reads: null, stdout: '' }
	);
}

/** One failed result per call of `batch`. */
export function hostErrorResults(
	batch: ScriptBatch,
	kind: HostErrorKind,
	message: string
): RawScriptResult[] {
	return batch.calls.map(() => ({ text: hostErrorText(batch, kind, message) }));
}
