import { pyRepr } from '../value/repr.ts';

// Python's `int()` on ASCII text: optional sign, digits, single underscores between digits.
const PY_INT = /^[+-]?\d+(?:_\d+)*$/;

function pyInt(text: string): number {
	const trimmed = text.trim();
	if (!PY_INT.test(trimmed)) throw new RangeError('not an integer');
	// `|| 0` turns the `-0` that `Number('-0')` yields into Python's plain 0.
	return Number(trimmed.replaceAll('_', '')) || 0;
}

const cache = new Map<string, Multiplicity>();

export class Multiplicity {
	readonly lower: number;
	/** `null` is unbounded (`*`). */
	readonly upper: number | null;

	constructor(lower: number, upper: number | null) {
		this.lower = lower;
		this.upper = upper;
	}

	get isSingle(): boolean {
		return this.upper === 1;
	}

	get required(): boolean {
		return this.lower >= 1;
	}

	countOk(count: number): boolean {
		if (count < this.lower) return false;
		return this.upper === null || count <= this.upper;
	}

	/** Parses `n`, `lo..hi` or `*`; throws a `RangeError` with the oracle's message otherwise. */
	static parse(spec: string): Multiplicity {
		const cached = cache.get(spec);
		if (cached !== undefined) return cached;
		const text = spec.trim();
		let parsed: Multiplicity;
		try {
			const dots = text.indexOf('..');
			if (dots >= 0) {
				const hi = text.slice(dots + 2);
				parsed = new Multiplicity(pyInt(text.slice(0, dots)), hi.trim() === '*' ? null : pyInt(hi));
			} else if (text === '*') {
				parsed = new Multiplicity(0, null);
			} else {
				const n = pyInt(text);
				parsed = new Multiplicity(n, n);
			}
		} catch {
			throw new RangeError('Invalid multiplicity: ' + pyRepr(text));
		}
		cache.set(spec, parsed);
		return parsed;
	}
}
