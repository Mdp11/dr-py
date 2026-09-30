import { dumpDefault } from './bridge.ts';
import { FACADE_SOURCE } from './facade.generated.ts';
import { HARNESS_SOURCE } from './harness.generated.ts';
import type { RawScriptResult, ScriptBatch } from './host.ts';
import type { Value } from '../value/types.ts';

/** The part of a Pyodide interpreter the guest uses. */
export type Interpreter = {
	runPython(code: string): unknown;
	globals: { set(name: string, value: unknown): void; get(name: string): unknown };
};

/** What the harness caps, in characters, and how many element reads the facade memoizes. */
export type HarnessLimits = {
	readonly stdoutChars: number;
	readonly reprChars: number;
	readonly readMemoMax: number;
};

export const DEFAULT_HARNESS_LIMITS: HarnessLimits = Object.freeze({
	stdoutChars: 262144,
	reprChars: 65536,
	readMemoMax: 4096
});

/** Called around each call of a batch, in order, for every call the batch holds. */
export type GuestHooks = {
	callStart?(i: number): void;
	callEnd?(i: number): void;
};

export type Guest = {
	/** `roots[i]` is the JSON text of call `i`'s projected elements. */
	run(batch: ScriptBatch, roots: readonly string[], hooks?: GuestHooks): RawScriptResult[];
};

/**
 * Run once per interpreter, after the globals `_dr_transport_text`, `_dr_facade`,
 * `_dr_harness`, `_dr_stdout_chars`, `_dr_repr_chars`, `_read_memo_max`, `_dr_call_start` and
 * `_dr_call_end` are set. The harness runs in this module's namespace; `_dr_batch` drives it and
 * answers one JSON array of the harness's own result texts, so what crosses back is a str and no
 * proxy exists to leak. There is no `except` here: the harness catches what a call raises, and a
 * `MemoryError` leaves for the host.
 */
export const GUEST_BOOTSTRAP = `
import json

_dr_limits = {"stdout_bytes": _dr_stdout_chars, "result_repr_bytes": _dr_repr_chars}

def _transport(req):
    return json.loads(_dr_transport_text(json.dumps(req)))

exec(compile(_dr_harness, "<harness>", "exec"), globals())

def _dr_batch(code, entry, calls_text, roots_texts, console):
    calls = json.loads(calls_text)
    roots = roots_texts.to_py()
    out = []
    if console:
        for i, call in enumerate(calls):
            _dr_call_start(i)
            res = _dr_run({
                "code": code,
                "facade": _dr_facade,
                "entry": entry,
                "element_ids": call["element_ids"],
                "inputs": call.get("inputs"),
                "limits": _dr_limits,
            })
            _dr_call_end(i)
            out.append(json.dumps(res))
        return json.dumps(out)
    session = _dr_open(_dr_facade, code, _dr_limits)
    boot_error = session["error"]
    for i, call in enumerate(calls):
        _dr_call_start(i)
        if boot_error is not None:
            res = {"payload": None, "error": boot_error, "reads": None, "stdout": ""}
        else:
            res = _dr_call(session, {
                "entry": entry,
                "element_ids": call["element_ids"],
                "elements": json.loads(roots[i]),
                "doc": call.get("doc"),
                "inputs": call.get("inputs"),
            }, _dr_limits)
        _dr_call_end(i)
        out.append(json.dumps(res))
    return json.dumps(out)
`;

type Callable = ((...args: unknown[]) => unknown) & { destroy?: () => void };

function callSpec(call: ScriptBatch['calls'][number]): Value {
	const spec: { [key: string]: Value } = { element_ids: [...call.elementIds] };
	if (call.inputs !== undefined) spec.inputs = call.inputs;
	if (call.doc !== undefined) spec.doc = call.doc;
	return spec;
}

/**
 * Boots the harness and the facade's host side in `py` and returns the batch runner.
 * `transport` answers one bridge request text with its reply text; it is called synchronously
 * from Python.
 */
export function createGuest(
	py: Interpreter,
	transport: (requestText: string) => string,
	limits: HarnessLimits = DEFAULT_HARNESS_LIMITS
): Guest {
	let hooks: GuestHooks | undefined;
	py.globals.set('_dr_transport_text', transport);
	py.globals.set('_dr_facade', FACADE_SOURCE);
	py.globals.set('_dr_harness', HARNESS_SOURCE);
	py.globals.set('_dr_stdout_chars', limits.stdoutChars);
	py.globals.set('_dr_repr_chars', limits.reprChars);
	py.globals.set('_read_memo_max', limits.readMemoMax);
	py.globals.set('_dr_call_start', (i: number) => hooks?.callStart?.(i));
	py.globals.set('_dr_call_end', (i: number) => hooks?.callEnd?.(i));
	py.runPython(GUEST_BOOTSTRAP);

	return {
		run(batch, roots, callHooks) {
			if (roots.length !== batch.calls.length) {
				throw new Error(`${batch.calls.length} calls but ${roots.length} root texts`);
			}
			const rootTexts = batch.entry === 'transform' ? batch.calls.map(() => '[]') : [...roots];
			const callsText = dumpDefault(batch.calls.map(callSpec));
			const consoleRun = batch.console === true || batch.entry === 'script';
			const runner = py.globals.get('_dr_batch') as Callable;
			let reply: unknown;
			hooks = callHooks;
			try {
				reply = runner(batch.code, batch.entry, callsText, rootTexts, consoleRun);
			} finally {
				hooks = undefined;
				runner.destroy?.();
			}
			if (typeof reply !== 'string') {
				(reply as { destroy?: () => void } | null)?.destroy?.();
				throw new Error('the guest returned a non-text reply');
			}
			// The reply is an array of strings; JSON.parse returns each as written.
			return (JSON.parse(reply) as string[]).map((text) => ({ text }));
		}
	};
}
