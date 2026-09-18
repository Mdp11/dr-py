/**
 * A Python `float`. Every float is wrapped, integral or not, so that
 * `typeof v === 'number'` always means a Python `int`.
 */
export class PyFloat {
	readonly value: number;

	constructor(value: number) {
		this.value = value;
	}
}

/** A JSON-ish property value as the Python core sees it. */
export type Value =
	null | boolean | number | bigint | string | PyFloat | Value[] | { [key: string]: Value };
