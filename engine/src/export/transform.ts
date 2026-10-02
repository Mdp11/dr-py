/**
 * An export's `transform(doc)`: the snippet run over a document once it is
 * shaped and before it is written, as `TransformHost.apply_ex` runs it. The
 * document goes to the guest as its compact JSON text, so the order of its keys
 * stands, and what comes back is read the same way. Both are held to the
 * server's `snippet_transform_max_bytes` as UTF-8, a lone surrogate refused as
 * Python's encoder refuses it. The call is read through the evaluation's
 * scripts: where it has not run yet it answers pending, and the pass is run
 * again once it has.
 */
import type { ScriptReader } from '../evaluate/fill.ts';
import type { Meter } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import type { ScriptError, TransformPayload } from '../script/result.ts';
import type { Steps } from '../steps/steps.ts';
import { PyFloat, type OrderedValue } from '../value/types.ts';
import { jsonTextSteps, type JsonOut } from './json.ts';
import { surrogateRefusal, utf8Encoder } from './utf8.ts';

// A lone surrogate, which `surrogateRefusal` then positions.
const LONE_SURROGATE = /\p{Cs}/u;

/** `snippet_transform_max_bytes`: the most a document or a result may hold, as compact JSON in UTF-8. */
export const TRANSFORM_MAX_BYTES = 8 * 1024 * 1024;

/** What one `transform(doc)` call came to: its result, its failure, or not yet. */
export type TransformOutcome =
	| { kind: 'ok'; value: OrderedValue; stdout: string }
	| { kind: 'failed'; error: ScriptError; stdout: string; boot: boolean }
	| { kind: 'syntax' }
	| { kind: 'pending' };

/**
 * A transform whose code does not compile, as the oracle refuses it before anything runs:
 * `detail` is that refusal. Thrown where the guest reported it, which is when the call runs.
 */
export class TransformSyntaxError extends ReadError {}

/** `type(value).__name__` of a JSON value. */
export function pyTypeName(value: OrderedValue): string {
	if (value === null) return 'NoneType';
	if (typeof value === 'string') return 'str';
	if (typeof value === 'boolean') return 'bool';
	if (typeof value === 'number' || typeof value === 'bigint') return 'int';
	if (value instanceof PyFloat) return 'float';
	return Array.isArray(value) ? 'list' : 'dict';
}

/** Whether `error` is the module failing to run rather than `transform` raising: a traceback through its own frame. */
function failedToLoad(error: ScriptError): boolean {
	return (
		error.traceback !== null &&
		/\n {2}File "<snippet>", line \d+, in <module>\n/.test(error.traceback)
	);
}

/** What a slice checks: about a millisecond of scanning and encoding. */
const CHECK_UNITS = 64 * 1024;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Refuses `text` over the cap as UTF-8 with `message`, or a lone surrogate as Python's encoder
 * does (before the cap, as its `encode` raises before `len` is read). A step a slice of the text.
 */
function* checkSize(text: string, message: string, meter: Meter): Steps<void> {
	const encoder = utf8Encoder();
	let bytes = 0;
	for (let at = 0; at < text.length;) {
		let end = Math.min(at + CHECK_UNITS, text.length);
		// A pair is never cut.
		if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end++;
		const slice = text.slice(at, end);
		if (LONE_SURROGATE.test(slice)) throw surrogateRefusal(text)!;
		bytes += encoder.encode(slice).length;
		meter.done += Math.ceil((end - at) / 64) - 1;
		if (meter.tick()) yield meter.end();
		at = end;
	}
	if (bytes > TRANSFORM_MAX_BYTES) throw new ReadError(422, message);
}

/**
 * `apply_ex`: `doc` through `code`'s `transform`, `name` naming the export in a
 * size refusal (a 422 whatever the caller does with a failed call). A call that
 * has not run answers `pending`.
 */
export function* transformSteps(
	scripts: ScriptReader,
	code: string,
	doc: JsonOut,
	name: string,
	meter: Meter
): Steps<TransformOutcome> {
	const docText = (yield* jsonTextSteps(doc, false, meter)).join('');
	yield* checkSize(
		docText,
		`${name}: transform document exceeds snippet_transform_max_bytes (${TRANSFORM_MAX_BYTES})`,
		meter
	);
	const result = scripts.read({
		code,
		entry: 'transform',
		elementIds: [],
		inputsText: null,
		docText
	});
	if (result.error !== null) {
		if (result.error.kind === 'pending') return { kind: 'pending' };
		if (result.error.kind === 'syntax') return { kind: 'syntax' };
		return {
			kind: 'failed',
			error: result.error,
			stdout: result.stdout,
			boot: failedToLoad(result.error)
		};
	}
	const { value } = result.payload as TransformPayload;
	const resultText = (yield* jsonTextSteps(value as JsonOut, false, meter)).join('');
	yield* checkSize(
		resultText,
		`${name}: transform result exceeds snippet_transform_max_bytes (${TRANSFORM_MAX_BYTES})`,
		meter
	);
	return { kind: 'ok', value, stdout: result.stdout };
}

/**
 * `TransformHost.apply` and the `jsonl` check: the document `doc` becomes, or the
 * export's 422. A call that has not run answers `doc` itself, for the pass that
 * asked to be run again. Code the guest could not compile is `syntaxRefusal`.
 */
export function* transformedSteps(
	scripts: ScriptReader,
	code: string,
	doc: JsonOut,
	jsonl: boolean,
	name: string,
	meter: Meter,
	syntaxRefusal: string
): Steps<JsonOut> {
	const out = yield* transformSteps(scripts, code, doc, name, meter);
	if (out.kind === 'pending') return doc;
	if (out.kind === 'syntax') throw new TransformSyntaxError(422, syntaxRefusal);
	if (out.kind === 'failed') {
		throw new ReadError(
			422,
			out.boot
				? `${name}: transform failed to load: ${out.error.message}`
				: `${name}: transform failed (${out.error.kind}): ${out.error.message}`
		);
	}
	if (jsonl && !Array.isArray(out.value)) {
		throw new ReadError(
			422,
			`${name}: transform must return a list for jsonl; got ${pyTypeName(out.value)}`
		);
	}
	return out.value as JsonOut;
}
