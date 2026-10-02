/**
 * A script column's call, as `core/table/script_inputs.py` makes it: its named
 * inputs resolved for one row to what the referenced column's cell holds, and
 * the one wrapper every `value()` call site goes through. An input is the
 * complete set the column holds, never the display cap's view of it. A pending
 * or failed input never reaches the guest: the call answers a synthetic result
 * instead, which is never read through the script reader and so is never
 * asked for, stored or cached.
 */
import type { ScriptReader } from '../evaluate/fill.ts';
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { PropertyValue } from '../navigation/evaluate.ts';
import type { NavScripts } from '../navigation/evaluate.ts';
import { entryArity } from '../script/arity.ts';
import type { ScriptResult, ValuePayload } from '../script/result.ts';
import { ScriptWarningLog } from '../script/warnings.ts';
import type { Steps } from '../steps/steps.ts';
import { pyRepr } from '../value/repr.ts';
import { pyDumps } from '../value/serialize.ts';
import type { Value } from '../value/types.ts';
import {
	expandSlotOf,
	navigationReached,
	resolveSourceElements,
	type Binding,
	type Pass,
	type RowKey
} from './rows.ts';
import type { NavigationColumn, PropertyColumn, ScriptColumn, ScriptInput } from './schema.ts';
import { propertyDeclared, rawProperty } from './virtual-props.ts';

/**
 * What the script columns of one evaluation read scripts through. `reader`
 * answers every call and remembers whether any answer was an error, `pending`
 * ones included; `warnings` is the evaluation's channel; `arity` is the
 * `value()` arity of a code, scanned once.
 */
export class TableScripts implements NavScripts {
	readonly reader: ScriptReader;
	readonly warnings = new ScriptWarningLog();
	private failed = false;
	private readonly arities = new Map<string, number | null>();

	constructor(reader: ScriptReader) {
		this.reader = {
			read: (call) => {
				const result = reader.read(call);
				if (result.error !== null) this.failed = true;
				return result;
			}
		};
	}

	/** Whether any call this evaluation read was answered with an error. */
	get errored(): boolean {
		return this.failed;
	}

	arity(code: string): number | null {
		let known = this.arities.get(code);
		if (known === undefined) {
			known = entryArity(code, 'value');
			this.arities.set(code, known);
		}
		return known;
	}
}

/** The first input that cannot reach the guest: still `pending`, or an `error`. */
export class InputFailure {
	readonly name: string;
	readonly kind: 'pending' | 'error';
	readonly message: string;
	readonly traceback: string | null;

	constructor(name: string, kind: 'pending' | 'error', message: string, traceback: string | null) {
		this.name = name;
		this.kind = kind;
		this.message = message;
		this.traceback = traceback;
	}
}

type WireInput = { kind: 'elements'; ids: string[] } | { kind: 'scalars'; values: Value[] };

/** The tagged wire shape the guest turns into `inputs[name]`, in declaration order. */
export type ResolvedInputs = { [name: string]: WireInput };

const elementsInput = (ids: string[]): WireInput => ({ kind: 'elements', ids });
const scalarsInput = (values: Value[]): WireInput => ({ kind: 'scalars', values });

export const danglingRefMessage = (ref: string): string =>
	`snippet artifact ${pyRepr(ref)} not found`;

/**
 * What a value-projected navigation cell shows: a value is itself, an element
 * of a mixed frontier its display name. Shared with the cell so an input's
 * values and the rendered cell cannot drift.
 */
export function navigationDisplayValues(
	model: Model,
	reached: readonly (string | PropertyValue)[]
): Value[] {
	return reached.map((node) =>
		typeof node === 'string' ? displayName(model.getElement(node)) : node.value
	);
}

/**
 * What a collapse property column holds over `owners`: lists flattened, `null`
 * skipped, an owner whose type does not declare it contributing nothing.
 */
export function propertyInputValues(
	pass: Pass,
	col: PropertyColumn,
	owners: readonly string[]
): Value[] {
	const values: Value[] = [];
	for (const id of owners) {
		const element = pass.model.getElement(id);
		if (!propertyDeclared(pass.mm, element.typeName, col.name)) continue;
		const v = rawProperty(element, col.name);
		if (Array.isArray(v)) values.push(...v);
		else if (v !== undefined && v !== null) values.push(v);
	}
	return values;
}

const synthetic = (
	kind: 'pending' | 'runtime',
	message: string,
	traceback: string | null
): ScriptResult => ({
	payload: null,
	error: { kind, message, traceback },
	reads: null,
	stdout: ''
});

/** The result of a column that holds an input failure, which no call ran. */
export function failureResult(f: InputFailure): ScriptResult {
	return synthetic(
		f.kind === 'pending' ? 'pending' : 'runtime',
		`input ${pyRepr(f.name)}: ${f.message}`,
		f.traceback
	);
}

function failureOf(name: string, result: ScriptResult): InputFailure {
	const { error } = result;
	return new InputFailure(
		name,
		error!.kind === 'pending' ? 'pending' : 'error',
		error!.message,
		error!.traceback
	);
}

/** The ids a value payload names that are elements: one, or the set in first-seen order. */
export function payloadElementIds(model: Model, payload: ValuePayload): string[] {
	if (payload.kind === 'element')
		return model.findElement(payload.id) === undefined ? [] : [payload.id];
	if (payload.kind !== 'elements') return [];
	return [...new Set(payload.ids)].filter((id) => model.findElement(id) !== undefined);
}

/**
 * The first failing input in declaration order; `null` when the column
 * declares none (a one-argument `value()`).
 */
export function* resolveScriptInputs(
	pass: Pass,
	key: RowKey,
	col: ScriptColumn
): Steps<ResolvedInputs | InputFailure | null> {
	if (col.inputs.length === 0) return null;
	const out: ResolvedInputs = {};
	for (const input of col.inputs) {
		const resolved = yield* resolveOne(pass, key, input);
		if (resolved instanceof InputFailure) return resolved;
		out[input.name] = resolved;
	}
	return out;
}

function* resolveOne(pass: Pass, key: RowKey, input: ScriptInput): Steps<WireInput | InputFailure> {
	const { model, defn } = pass;
	const refCol = defn.columns[input.ref.index]!;
	if (input.ref.step_index !== null) {
		// A navigation ref at a chain step is element-producing by contract.
		return elementsInput(yield* resolveSourceElements(pass, key, input.ref));
	}
	if (refCol.kind !== 'element' && refCol.mode === 'expand') {
		return yield* resolveExpandInput(pass, key, input, refCol);
	}
	const roots = yield* resolveSourceElements(pass, key, refCol.source);
	if (refCol.kind === 'property') return scalarsInput(propertyInputValues(pass, refCol, roots));
	if (refCol.kind === 'element') return elementsInput(roots);
	if (refCol.kind === 'navigation') {
		const [reached] = yield* navigationReached(pass, refCol, roots);
		if (reached.some((node) => node instanceof PropertyValue)) {
			// The cell shows values: a mixed frontier degrades element nodes to their names.
			return scalarsInput(navigationDisplayValues(model, reached));
		}
		return elementsInput(reached as string[]);
	}
	const result = yield* scriptResult(pass, key, refCol, roots);
	if (result.error !== null) return failureOf(input.name, result);
	const payload = result.payload as ValuePayload;
	if (payload.kind === 'scalar') return scalarsInput(payload.value === null ? [] : [payload.value]);
	if (payload.kind === 'scalars') return scalarsInput([...payload.values]);
	return elementsInput(payloadElementIds(model, payload));
}

function* resolveExpandInput(
	pass: Pass,
	key: RowKey,
	input: ScriptInput,
	refCol: PropertyColumn | NavigationColumn | ScriptColumn
): Steps<WireInput | InputFailure> {
	const { defn, baseSlots } = pass;
	const b: Binding | undefined = key[expandSlotOf(defn, baseSlots, input.ref.index)];
	if (refCol.kind === 'property') {
		// A property slot holds the raw value, never a wrapper: a text value is not an element id.
		return scalarsInput(b === null || b === undefined ? [] : [b as Value]);
	}
	if (typeof b === 'string') return elementsInput([b]);
	if (b instanceof PropertyValue) return scalarsInput([b.value]);
	if (refCol.kind === 'script') {
		// An empty slot is a row kept empty or a cell that errored or is pending: re-deriving the
		// column's call tells them apart.
		const roots = yield* resolveSourceElements(pass, key, refCol.source);
		const result = yield* scriptResult(pass, key, refCol, roots);
		if (result.error !== null) return failureOf(input.name, result);
	}
	return scalarsInput([]);
}

/**
 * A script column's call result for one row, the dangling ref, the
 * unconfigured source and the no-roots cases answered here, ahead of the call,
 * so an input's failure has the shape the cell's has whatever order a caller
 * checks things in.
 */
function* scriptResult(
	pass: Pass,
	key: RowKey,
	col: ScriptColumn,
	roots: readonly string[]
): Steps<ScriptResult> {
	if (col.snippet.ref !== null)
		return synthetic('runtime', danglingRefMessage(col.snippet.ref), null);
	if (col.snippet.definition === null || roots.length === 0) {
		return { payload: { kind: 'scalars', values: [] }, error: null, reads: null, stdout: '' };
	}
	return yield* evaluateScriptColumn(pass, key, col, roots);
}

const arityError = (message: string): ScriptResult => synthetic('runtime', message, null);

/**
 * The `value()` call of a script column over `roots`: its inputs resolved,
 * then the call read through the pass's scripts. The caller has dealt with a
 * dangling ref, an unconfigured source and no roots, as its cell renders them.
 */
export function* evaluateScriptColumn(
	pass: Pass,
	key: RowKey,
	col: ScriptColumn,
	roots: readonly string[]
): Steps<ScriptResult> {
	const scripts = pass.scripts!;
	const code = (col.snippet.definition as { code: string }).code;
	const arity = scripts.arity(code);
	const n = col.inputs.length;
	if (arity === 1 && n > 0) {
		return arityError(
			`value() takes 1 argument but column declares ${n} input${n !== 1 ? 's' : ''}`
		);
	}
	if (arity === 2 && n === 0) {
		return arityError('value() takes 2 arguments but column declares no inputs');
	}
	const inputs = yield* resolveScriptInputs(pass, key, col);
	if (inputs instanceof InputFailure) return failureResult(inputs);
	return scripts.reader.read({
		code,
		entry: 'value',
		elementIds: roots,
		inputsText: inputs === null ? null : pyDumps(inputs as Value, undefined, { allowNan: true }),
		docText: null
	});
}
