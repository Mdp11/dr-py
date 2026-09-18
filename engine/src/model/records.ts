import type { Value } from '../value/types.ts';

/** An entity's properties, in insertion order. */
export type Props = { [key: string]: Value };

/**
 * One element. Fixed shape: every field is set in the constructor, in one
 * order. `out`, `in` and `parents` hold direct record references and are
 * maintained by the index hooks; `out` and `in` have no specified order,
 * `parents` holds the containment relationships targeting this element in
 * relationship order — the first one is the owner.
 */
export class ElementRec {
	readonly id: string;
	typeName: string;
	props: Props;
	rev: number;
	/** Insertion sequence. Sparse after churn; only its order means anything. */
	ord: number;
	out: RelRec[];
	in: RelRec[];
	parents: RelRec[];
	/** Index-owned: the uniqueness bucket this element is filed under. */
	uniq: number;
	/** Index-owned: the display name it is filed under as a root, `null` for a non-root. */
	rootName: string | null;

	constructor(id: string, typeName: string, props: Props, rev: number, ord: number) {
		this.id = id;
		this.typeName = typeName;
		this.props = props;
		this.rev = rev;
		this.ord = ord;
		this.out = [];
		this.in = [];
		this.parents = [];
		this.uniq = 0;
		this.rootName = null;
	}
}

/** One relationship, holding its endpoints by reference. */
export class RelRec {
	readonly id: string;
	typeName: string;
	readonly source: ElementRec;
	readonly target: ElementRec;
	props: Props;
	rev: number;
	ord: number;
	/** Index-owned: where this record sits in `source.out` and in `target.in`. */
	outAt: number;
	inAt: number;

	constructor(
		id: string,
		typeName: string,
		source: ElementRec,
		target: ElementRec,
		props: Props,
		rev: number,
		ord: number
	) {
		this.id = id;
		this.typeName = typeName;
		this.source = source;
		this.target = target;
		this.props = props;
		this.rev = rev;
		this.ord = ord;
		this.outAt = -1;
		this.inAt = -1;
	}
}

// Property bags are plain objects, so a key such as `constructor` or
// `__proto__` must never reach the prototype chain.

export function getProp(props: Props, key: string): Value | undefined {
	return Object.hasOwn(props, key) ? props[key] : undefined;
}

/** Appends a new key; an existing key keeps its place, as in a Python dict. */
export function setProp(props: Props, key: string, value: Value): void {
	if (key === '__proto__') {
		Object.defineProperty(props, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
	} else {
		props[key] = value;
	}
}
