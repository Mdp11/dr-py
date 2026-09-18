/**
 * A call the mutation boundary refuses. `kind` keeps the oracle's distinction
 * between a `KeyError` (something named does not exist) and a `ValueError`
 * (it exists but cannot be used that way); `message` is the oracle's text.
 */
export class ModelError extends Error {
	readonly kind: 'key' | 'value';

	constructor(kind: 'key' | 'value', message: string) {
		super(message);
		this.name = 'ModelError';
		this.kind = kind;
	}
}

/** A snapshot entity the bulk loader cannot accept. */
export class SnapshotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SnapshotError';
	}
}
