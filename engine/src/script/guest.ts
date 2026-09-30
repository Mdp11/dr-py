import { dumpDefault } from './bridge.ts';
import { FACADE_SOURCE } from './facade.generated.ts';
import type { RawScriptResult, ScriptBatch } from './host.ts';
import type { Value } from '../value/types.ts';

/** The part of a Pyodide interpreter the guest uses. */
export type Interpreter = {
	runPython(code: string): unknown;
	globals: { set(name: string, value: unknown): void; get(name: string): unknown };
};

export type Guest = {
	/** `roots[i]` is the JSON text of call `i`'s projected elements. */
	run(batch: ScriptBatch, roots: readonly string[]): RawScriptResult[];
};

/**
 * Run once per interpreter, after `_dr_transport_text`, `_dr_facade` and
 * `_dr_read_memo_max` are set. Each batch executes the facade and then the code in a fresh
 * namespace. `_dr_run` returns text, never a Python object: a str crosses as a JS string, so
 * no proxy exists to leak, and its one JSON layer holds only strings and null.
 */
export const GUEST_BOOTSTRAP = `
import json

_dr_facade_code = compile(_dr_facade, "<facade>", "exec")

def _transport(req):
    return json.loads(_dr_transport_text(json.dumps(req)))

def _dr_error(exc):
    return {"error": type(exc).__name__ + ": " + str(exc)}

def _dr_run(code, entry, calls_text, roots_texts):
    calls = json.loads(calls_text)
    roots_texts = roots_texts.to_py()
    try:
        ns = {"_transport": _transport, "_read_memo_max": _dr_read_memo_max}
        exec(_dr_facade_code, ns)
        exec(compile(code, "<snippet>", "exec"), ns)
        call_entry = ns["_dr_call_entry"]
    except BaseException as exc:
        failed = _dr_error(exc)
        return json.dumps([failed for _ in calls])
    out = []
    for call, roots_text in zip(calls, roots_texts):
        try:
            result = call_entry(
                entry,
                call["element_ids"],
                json.loads(roots_text),
                call.get("doc"),
                call.get("inputs"),
            )
            out.append({"text": json.dumps(result)})
        except (Exception, SystemExit) as exc:
            out.append(_dr_error(exc))
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
 * Boots the facade's host side in `py` and returns the batch runner. `transport` answers one
 * bridge request text with its reply text; it is called synchronously from Python.
 */
export function createGuest(
	py: Interpreter,
	transport: (requestText: string) => string,
	readMemoMax = 4096
): Guest {
	py.globals.set('_dr_transport_text', transport);
	py.globals.set('_dr_facade', FACADE_SOURCE);
	py.globals.set('_dr_read_memo_max', readMemoMax);
	py.runPython(GUEST_BOOTSTRAP);

	return {
		run(batch, roots) {
			if (roots.length !== batch.calls.length) {
				throw new Error(`${batch.calls.length} calls but ${roots.length} root texts`);
			}
			const rootTexts = batch.entry === 'transform' ? batch.calls.map(() => '[]') : [...roots];
			const callsText = dumpDefault(batch.calls.map(callSpec));
			const runner = py.globals.get('_dr_run') as Callable;
			let reply: unknown;
			try {
				reply = runner(batch.code, batch.entry, callsText, rootTexts);
			} finally {
				runner.destroy?.();
			}
			if (typeof reply !== 'string') {
				(reply as { destroy?: () => void } | null)?.destroy?.();
				throw new Error('the guest returned a non-text reply');
			}
			// The reply's only strings are `text` and `error`: JSON.parse returns them as written.
			const raw = JSON.parse(reply) as { text?: string; error?: string }[];
			return raw.map((r) => ({ text: r.text ?? null, error: r.error ?? null }));
		}
	};
}
