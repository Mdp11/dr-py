import { getProp, type ElementRec, type RelRec } from '../model/records.ts';
import { ModelError } from '../model/errors.ts';
import { nameOf } from '../model/naming.ts';
import type { Model } from '../model/model.ts';
import { PyIntLimitError, pyIntOf } from '../value/coerce.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { parseExact } from '../value/parse.ts';
import { pyRepr, pyReprValue } from '../value/repr.ts';
import { pyDumps } from '../value/serialize.ts';
import { PyFloat, type Value } from '../value/types.ts';

export type BridgeLimits = {
	maxOps: number;
	maxOpBytes: number;
	pageLimit: number;
	maxInlineFarEndpoints: number;
};

export const BRIDGE_LIMITS: BridgeLimits = Object.freeze({
	maxOps: 1000,
	maxOpBytes: 1024 * 1024,
	pageLimit: 500,
	maxInlineFarEndpoints: 2048
});

type Dict = { [key: string]: Value };

/** Python's bare `json.dumps(value)`: ASCII-only, `", "` and `": "`, NaN and Infinity allowed. */
export function dumpDefault(value: Value): string {
	return pyDumps(value, undefined, { ascii: true, spaced: true, allowNan: true });
}

/** A failure the oracle raises as a Python exception; the reply carries `Name: message`. */
class BridgeError extends Error {
	readonly pyName: string;

	constructor(pyName: string, message: string) {
		super(message);
		this.name = 'BridgeError';
		this.pyName = pyName;
	}
}

// `str(KeyError(message))` is the message's repr.
const keyError = (message: string) => new BridgeError('KeyError', pyRepr(message));

function isDict(value: Value | undefined): value is Dict {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof PyFloat)
	);
}

function pyTypeName(value: Value): string {
	if (value === null) return 'NoneType';
	if (typeof value === 'boolean') return 'bool';
	if (typeof value === 'number' || typeof value === 'bigint') return 'int';
	if (value instanceof PyFloat) return 'float';
	if (typeof value === 'string') return 'str';
	return Array.isArray(value) ? 'list' : 'dict';
}

/** `req.get(key)`: an absent key reads as `None`. */
function optional(req: Dict, key: string): Value {
	return Object.hasOwn(req, key) ? req[key]! : null;
}

/** `req[key]`. */
function required(req: Dict, key: string): Value {
	if (!Object.hasOwn(req, key)) throw keyError(key);
	return req[key]!;
}

/** A value used as a dict key: a list or a dict cannot be. */
function requireHashable(value: Value): void {
	if (Array.isArray(value) || isDict(value)) {
		const name = pyTypeName(value);
		throw new BridgeError(
			'TypeError',
			`cannot use '${name}' as a dict key (unhashable type: '${name}')`
		);
	}
}

function truthy(value: Value): boolean {
	if (value === null || value === false || value === 0 || value === '') return false;
	if (value instanceof PyFloat) return value.value !== 0;
	if (Array.isArray(value)) return value.length > 0;
	if (isDict(value)) return Object.keys(value).length > 0;
	return true;
}

/** `int(value)`. */
function pyInt(value: Value): bigint {
	if (typeof value === 'boolean') return value ? 1n : 0n;
	if (typeof value === 'number') return BigInt(value);
	if (typeof value === 'bigint') return value;
	if (value instanceof PyFloat) {
		if (Number.isNaN(value.value))
			throw new BridgeError('ValueError', 'cannot convert float NaN to integer');
		if (!Number.isFinite(value.value)) {
			throw new BridgeError('OverflowError', 'cannot convert float infinity to integer');
		}
		return BigInt(Math.trunc(value.value));
	}
	if (typeof value === 'string') {
		let parsed: bigint | null;
		try {
			parsed = pyIntOf(value);
		} catch (error) {
			if (error instanceof PyIntLimitError) throw new BridgeError('ValueError', error.message);
			throw error;
		}
		if (parsed === null) {
			throw new BridgeError(
				'ValueError',
				`invalid literal for int() with base 10: ${pyRepr(value)}`
			);
		}
		return parsed;
	}
	throw new BridgeError(
		'TypeError',
		`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`
	);
}

/** `model.get_element(id)` for an id off the wire. */
function getElement(model: Model, id: Value): ElementRec {
	requireHashable(id);
	if (typeof id === 'string') return model.getElement(id);
	throw keyError(`No element with id ${pyReprValue(id)}`);
}

function projectElement(element: ElementRec): Dict {
	return {
		id: element.id,
		type: element.typeName,
		name: nameOf(element),
		properties: element.props
	};
}

function projectRelationship(rel: RelRec): Dict {
	return {
		id: rel.id,
		type: rel.typeName,
		name: getProp(rel.props, 'name') ?? null,
		properties: rel.props,
		source_id: rel.source.id,
		target_id: rel.target.id
	};
}

/** The elements still in `model`, in input order; an absent id is left out. */
export function projectRoots(model: Model, ids: readonly string[]): Value[] {
	const out: Value[] = [];
	for (const id of ids) {
		const element = model.findElement(id);
		if (element !== undefined) out.push(projectElement(element));
	}
	return out;
}

const byId = (a: RelRec, b: RelRec) => cmpCodePoint(a.id, b.id);

/**
 * Answers one bridge request at a time against a model it only reads. A write
 * is recorded, verbatim, in `ops` and never applied.
 */
export class BridgeDispatcher {
	readonly ops: Value[] = [];
	private readonly model: Model;
	private readonly recordOps: boolean;
	private readonly limits: BridgeLimits;
	private opBytes = 0;

	constructor(model: Model, recordOps: boolean, limits: Partial<BridgeLimits> = {}) {
		this.model = model;
		this.recordOps = recordOps;
		this.limits = {
			maxOps: limits.maxOps ?? BRIDGE_LIMITS.maxOps,
			maxOpBytes: limits.maxOpBytes ?? BRIDGE_LIMITS.maxOpBytes,
			pageLimit: limits.pageLimit ?? BRIDGE_LIMITS.pageLimit,
			maxInlineFarEndpoints: limits.maxInlineFarEndpoints ?? BRIDGE_LIMITS.maxInlineFarEndpoints
		};
	}

	/** Request text in, reply text out. Nothing escapes: a failure is an `error` reply. */
	dispatch(requestText: string): string {
		let req: Dict;
		try {
			const parsed = parseExact(requestText, { floatConstants: true, controlCharacters: false });
			if (!isDict(parsed)) {
				return dumpDefault({ id: null, error: 'ValueError: request is not a JSON object' });
			}
			req = parsed;
		} catch (error) {
			return dumpDefault({
				id: null,
				error: `ValueError: request is not valid JSON: ${describe(error)}`
			});
		}
		const id = optional(req, 'id');
		let reply: Dict;
		try {
			reply = { ...this.handle(req), id };
		} catch (error) {
			reply = { id, error: failure(error) };
		}
		try {
			return dumpDefault(reply);
		} catch (error) {
			return dumpDefault({ id: null, error: `RuntimeError: ${describe(error)}` });
		}
	}

	private handle(req: Dict): Dict {
		const op = optional(req, 'op');
		if (isDict(op)) return this.recordOp(op);
		if (typeof op !== 'string') {
			throw new BridgeError('ValueError', `'op' must be a str or dict, got ${pyReprValue(op)}`);
		}
		switch (op) {
			case 'element':
				return this.opElement(req);
			case 'elements_page':
				return this.opElementsPage(req);
			case 'outgoing':
				return this.opOutgoing(req);
			case 'incoming':
				return this.opIncoming(req);
			case 'parent':
				return this.opParent(req);
			case 'children':
				return this.opChildren(req);
			case 'descendants':
				return this.opDescendants(req);
			default:
				throw new BridgeError('ValueError', `unknown op ${pyRepr(op)}`);
		}
	}

	private opElement(req: Dict): Dict {
		const element = getElement(this.model, required(req, 'element_id'));
		return { element: projectElement(element) };
	}

	private opElementsPage(req: Dict): Dict {
		const typeNames = optional(req, 'type');
		const offsetRaw = optional(req, 'offset');
		const offset = bounded(truthy(offsetRaw) ? pyInt(offsetRaw) : 0n, 0, Number.MAX_SAFE_INTEGER);
		const limitRaw = optional(req, 'limit');
		const limit =
			limitRaw === null
				? this.limits.pageLimit
				: bounded(pyInt(limitRaw), 0, this.limits.pageLimit);

		const allowed = this.allowedTypes(typeNames);
		const page: ElementRec[] = [];
		let skipped = 0;
		let hasMore = false;
		for (const element of this.model.elements()) {
			if (allowed !== null && !allowed.has(element.typeName)) continue;
			if (skipped < offset) {
				skipped++;
				continue;
			}
			if (page.length >= limit) {
				hasMore = true;
				break;
			}
			page.push(element);
		}
		return {
			elements: page.map(projectElement),
			next_offset: hasMore ? offset + limit : null
		};
	}

	/** `null` is no filter; a name, or a list of names, expands to its descendant closure. */
	private allowedTypes(typeNames: Value): Set<string> | null {
		if (typeNames === null) return null;
		let names: readonly Value[];
		if (typeof typeNames === 'string') names = [typeNames];
		else if (Array.isArray(typeNames)) names = typeNames;
		else if (isDict(typeNames)) names = Object.keys(typeNames);
		else throw new BridgeError('TypeError', `'${pyTypeName(typeNames)}' object is not iterable`);
		const allowed = new Set<string>();
		for (const name of names) {
			requireHashable(name);
			if (typeof name !== 'string') continue;
			for (const type of this.model.metamodel.elementDescendants(name)) allowed.add(type);
		}
		return allowed;
	}

	private opOutgoing(req: Dict): Dict {
		const element = getElement(this.model, required(req, 'element_id'));
		const rels = [...element.out].sort(byId);
		return {
			relationships: rels.map(projectRelationship),
			elements: this.farEndpoints(rels.map((rel) => rel.target.id))
		};
	}

	private opIncoming(req: Dict): Dict {
		const element = getElement(this.model, required(req, 'element_id'));
		const rels = [...element.in].sort(byId);
		return {
			relationships: rels.map(projectRelationship),
			elements: this.farEndpoints(rels.map((rel) => rel.source.id))
		};
	}

	/**
	 * The far ends of a hop, inlined so the guest need not fetch each one:
	 * distinct, in first-appearance order. Past the cap none are inlined, which
	 * the guest tolerates by fetching the ones it reads; an end the model lacks
	 * is left out.
	 */
	private farEndpoints(ids: readonly string[]): Dict[] {
		const unique = [...new Set(ids)];
		if (unique.length > this.limits.maxInlineFarEndpoints) return [];
		const out: Dict[] = [];
		for (const id of unique) {
			const element = this.model.findElement(id);
			if (element !== undefined) out.push(projectElement(element));
		}
		return out;
	}

	private opParent(req: Dict): Dict {
		const element = getElement(this.model, required(req, 'element_id'));
		return { parent_id: this.model.containerOf(element.id) };
	}

	private opChildren(req: Dict): Dict {
		const element = getElement(this.model, required(req, 'element_id'));
		const metamodel = this.model.metamodel;
		const childIds = element.out
			.filter((rel) => metamodel.isContainment(rel.typeName))
			.map((rel) => rel.target.id)
			.sort(cmpCodePoint);
		return { children: childIds.map((id) => projectElement(this.model.getElement(id))) };
	}

	private opDescendants(req: Dict): Dict {
		const kind = optional(req, 'kind');
		const name = required(req, 'name');
		const metamodel = this.model.metamodel;
		if (kind === 'element') {
			requireHashable(name);
			if (typeof name !== 'string' || metamodel.elementType(name) === undefined) {
				throw keyError(`Unknown element stereotype ${pyReprValue(name)}`);
			}
			return { descendants: [...metamodel.elementDescendants(name)].sort(cmpCodePoint) };
		}
		if (kind === 'relationship') {
			requireHashable(name);
			if (typeof name !== 'string' || metamodel.relationshipType(name) === undefined) {
				throw keyError(`Unknown relationship stereotype ${pyReprValue(name)}`);
			}
			return { descendants: [...metamodel.relationshipDescendants(name)].sort(cmpCodePoint) };
		}
		throw new BridgeError('ValueError', `descendants: unknown kind ${pyReprValue(kind)}`);
	}

	private recordOp(op: Dict): Dict {
		if (!this.recordOps) {
			throw new BridgeError('ReadOnlyError', 'record_op is disabled on a read-only dispatcher');
		}
		if (this.ops.length >= this.limits.maxOps) {
			throw new BridgeError(
				'BridgeLimitError',
				`record_op: op cap exceeded (max_ops=${this.limits.maxOps})`
			);
		}
		const bytes = dumpDefault(op).length;
		if (this.opBytes + bytes > this.limits.maxOpBytes) {
			throw new BridgeError(
				'BridgeLimitError',
				`record_op: op byte cap exceeded (max_op_bytes=${this.limits.maxOpBytes})`
			);
		}
		this.ops.push(op);
		this.opBytes += bytes;
		const result: Dict = {};
		const tempId = optional(op, 'temp_id');
		if (tempId !== null) result.temp_id = tempId;
		return result;
	}
}

/** `max(low, min(value, high))`, as a number. */
function bounded(value: bigint, low: number, high: number): number {
	if (value < BigInt(low)) return low;
	if (value > BigInt(high)) return high;
	return Number(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The `error` text of a reply: the Python class name, a colon, the message. */
function failure(error: unknown): string {
	if (error instanceof BridgeError) return `${error.pyName}: ${error.message}`;
	if (error instanceof ModelError) {
		return error.kind === 'key'
			? `KeyError: ${pyRepr(error.message)}`
			: `ValueError: ${error.message}`;
	}
	return `RuntimeError: ${describe(error)}`;
}
