/**
 * One embedded call's result: the harness's answer text parsed once, its
 * payload checked for the entry it came from and its read-set checked, as the
 * oracle's session does (`decode_call_payload`, `decode_reads`). The guest
 * chooses what to send, never what it means: a payload outside the closed shape
 * of its entry is a `runtime` error, and a malformed read-set means "depends on
 * everything".
 */
import { parseExact, parseOrdered } from '../value/parse.ts';
import { PyFloat, type OrderedValue, type Value } from '../value/types.ts';

export type EmbeddedEntry = 'value' | 'step' | 'transform';

export type ReadTag = 'el' | 'out' | 'in' | 'children' | 'parent' | 'scan';

/**
 * What a call read, the model's side of a cache key: an element, a node's
 * outgoing or incoming relationships, its containment children or parent, or a
 * scan over a type (`null` for every type). A tag the guest invented is kept
 * as the oracle keeps it; it never matches a key a transition touches.
 */
export type ReadKey = readonly [ReadTag, string | null];

export type ScriptErrorKind =
	'syntax' | 'runtime' | 'timeout' | 'cancelled' | 'memory' | 'unavailable' | 'pending' | 'limit';

export type ScriptError = {
	readonly kind: ScriptErrorKind;
	readonly message: string;
	readonly traceback: string | null;
};

export type ValuePayload =
	| { kind: 'scalar'; value: Value }
	| { kind: 'scalars'; values: Value[] }
	| { kind: 'element'; id: string }
	| { kind: 'elements'; ids: string[] };

/** A step's nodes: element ids and terminal values alike; the navigation tells them apart. */
export type StepPayload = { nodes: Value[] };

/** A transform's document, its objects with an array-index key `Map`s, so that their order is the transform's. */
export type TransformPayload = { kind: 'json'; value: OrderedValue };

/**
 * `payload` is set exactly when `error` is not. `reads` is `null` when the call
 * errored or depends on everything. `stdout` is what the call printed.
 */
export type ScriptResult = {
	readonly payload: ValuePayload | StepPayload | TransformPayload | null;
	readonly error: ScriptError | null;
	readonly reads: readonly ReadKey[] | null;
	readonly stdout: string;
};

/** A call no fill has answered yet; never stored. */
export const PENDING: ScriptResult = Object.freeze({
	payload: null,
	error: Object.freeze({ kind: 'pending', message: 'not computed yet', traceback: null }),
	reads: null,
	stdout: ''
});

type Doc = { [key: string]: Value };

const isDoc = (value: Value | undefined): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

// A missing member reads as `null`, as `dict.get` does.
const member = (doc: Doc, key: string): Value => (Object.hasOwn(doc, key) ? doc[key]! : null);

const isWireScalar = (value: Value): boolean =>
	typeof value === 'string' ||
	typeof value === 'number' ||
	typeof value === 'bigint' ||
	typeof value === 'boolean' ||
	value instanceof PyFloat;

const isNullOrWireScalar = (value: Value): boolean => value === null || isWireScalar(value);

const isString = (value: Value): value is string => typeof value === 'string';

function all(values: Value, test: (value: Value) => boolean): values is Value[] {
	return Array.isArray(values) && values.every(test);
}

type Decoded = { payload: ValuePayload | StepPayload | TransformPayload } | { message: string };

function decodePayload(entry: EmbeddedEntry, payload: Value): Decoded {
	if (!isDoc(payload)) return { message: 'malformed call result payload' };
	if (entry === 'transform') {
		if (member(payload, 'kind') === 'json' && Object.hasOwn(payload, 'value')) {
			return { payload: { kind: 'json', value: payload['value']! } };
		}
		return { message: 'malformed transform() result payload' };
	}
	if (entry === 'step') {
		const nodes = member(payload, 'nodes');
		if (all(nodes, isWireScalar)) return { payload: { nodes } };
		return { message: 'malformed step() result payload' };
	}
	const kind = member(payload, 'kind');
	if (kind === 'scalar') {
		const value = member(payload, 'value');
		if (isNullOrWireScalar(value)) return { payload: { kind, value } };
	} else if (kind === 'scalars') {
		const values = member(payload, 'values');
		if (all(values, isNullOrWireScalar)) return { payload: { kind, values } };
	} else if (kind === 'element') {
		const id = member(payload, 'id');
		if (isString(id)) return { payload: { kind, id } };
	} else if (kind === 'elements') {
		const ids = member(payload, 'ids');
		if (all(ids, isString)) return { payload: { kind, ids: ids as string[] } };
	}
	return { message: 'malformed value() result payload' };
}

const MAX_READS = 2000;
const MAX_READ_TAG_LEN = 32;
const MAX_READ_ID_LEN = 512;

// Lengths count code points, as Python's do.
const within = (text: string, max: number): boolean =>
	text.length <= max || [...text].length <= max;

function decodeReads(raw: Value): readonly ReadKey[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_READS) return null;
	const seen = new Set<string>();
	const keys: ReadKey[] = [];
	for (const item of raw) {
		if (!Array.isArray(item) || item.length !== 2) return null;
		const [tag, id] = item as [Value, Value];
		if (typeof tag !== 'string' || !within(tag, MAX_READ_TAG_LEN)) return null;
		if (id !== null && (typeof id !== 'string' || !within(id, MAX_READ_ID_LEN))) return null;
		const identity = JSON.stringify([tag, id]);
		if (seen.has(identity)) continue;
		seen.add(identity);
		keys.push([tag as ReadTag, id]);
	}
	return keys;
}

function malformed(what: string): never {
	throw new Error(`script result: ${what}`);
}

function decodeError(raw: Value): ScriptError | null {
	if (raw === null) return null;
	if (!isDoc(raw)) return malformed('error is not an object');
	const { kind, message, traceback = null } = raw;
	if (typeof kind !== 'string' || typeof message !== 'string') {
		return malformed('error has no kind and message');
	}
	if (traceback !== null && typeof traceback !== 'string') {
		return malformed('error traceback is not text');
	}
	return { kind: kind as ScriptErrorKind, message, traceback };
}

/**
 * The harness's `{payload, error, reads, stdout}` text for one call of `entry`,
 * parsed exactly (the guest's `json.dumps` writes `NaN` and `Infinity`; a
 * transform's document is parsed by `parseOrdered`). The
 * envelope is the harness's, so a text that is not one throws; the payload and
 * the read-set are the guest's, so a malformed one is an answer: a `runtime`
 * error for the payload, `null` reads for the read-set. A call that errored or
 * whose payload is malformed answers with its output, no payload and no
 * read-set.
 */
export function parseScriptResult(text: string, entry: EmbeddedEntry): ScriptResult {
	const floats = { floatConstants: true };
	// A transform returns a whole document, whose key order is part of it: the envelope is plain,
	// its `value` may hold `Map`s.
	const answer =
		entry === 'transform' ? (parseOrdered(text, floats) as Value) : parseExact(text, floats);
	if (!isDoc(answer)) return malformed('not an object');
	for (const key of ['payload', 'error', 'reads', 'stdout']) {
		if (!Object.hasOwn(answer, key)) return malformed(`no ${key}`);
	}
	const stdout = answer['stdout'];
	if (typeof stdout !== 'string') return malformed('stdout is not text');
	const error = decodeError(answer['error']!);
	if (error !== null) return { payload: null, error, reads: null, stdout };
	const decoded = decodePayload(entry, answer['payload']!);
	if ('message' in decoded) {
		return {
			payload: null,
			error: { kind: 'runtime', message: decoded.message, traceback: null },
			reads: null,
			stdout
		};
	}
	return { payload: decoded.payload, error: null, reads: decodeReads(answer['reads']!), stdout };
}
