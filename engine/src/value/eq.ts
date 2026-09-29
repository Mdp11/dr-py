import { PyFloat, type Value } from './types.ts';

type Int = boolean | number | bigint;

const isInt = (v: Value): v is Int =>
	typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint';

function intEq(a: Int, b: Int): boolean {
	if (typeof a === typeof b) return a === b;
	return BigInt(a) === BigInt(b);
}

function numEq(a: Int | PyFloat, b: Int | PyFloat): boolean {
	if (a instanceof PyFloat) {
		if (b instanceof PyFloat) return a.value === b.value;
		return floatIntEq(a.value, b);
	}
	if (b instanceof PyFloat) return floatIntEq(b.value, a);
	return intEq(a, b);
}

/** A float equals an int only when it is finite, integral and the same integer. */
function floatIntEq(f: number, i: Int): boolean {
	if (!Number.isInteger(f)) return false;
	return BigInt(f) === BigInt(i);
}

/** Python `==` over two values. Iterative: a deeply nested value must not overflow the stack. */
export function pyEq(a: Value, b: Value): boolean {
	const stack: Value[] = [a, b];
	while (stack.length > 0) {
		const y = stack.pop()!;
		const x = stack.pop()!;
		if (x === null || y === null || typeof x === 'string' || typeof y === 'string') {
			if (x !== y) return false;
		} else if (Array.isArray(x)) {
			if (!Array.isArray(y) || x.length !== y.length) return false;
			for (let i = 0; i < x.length; i++) stack.push(x[i]!, y[i]!);
		} else if (Array.isArray(y)) {
			return false;
		} else if (isInt(x) || x instanceof PyFloat || isInt(y) || y instanceof PyFloat) {
			const numX = isInt(x) || x instanceof PyFloat;
			const numY = isInt(y) || y instanceof PyFloat;
			if (!numX || !numY || !numEq(x as Int | PyFloat, y as Int | PyFloat)) return false;
		} else {
			const dx = x as { [key: string]: Value };
			const dy = y as { [key: string]: Value };
			const keys = Object.keys(dx);
			if (keys.length !== Object.keys(dy).length) return false;
			for (const key of keys) {
				if (!Object.prototype.hasOwnProperty.call(dy, key)) return false;
				stack.push(dx[key]!, dy[key]!);
			}
		}
	}
	return true;
}
