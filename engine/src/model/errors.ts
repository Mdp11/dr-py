import { pyRepr } from '../value/repr.ts';

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

/**
 * The server's text for a refusal: it strips the quotes off the ends of a
 * missing-key message, whichever they are (`No element with id 'x`).
 */
export function errorDetail(error: ModelError): string {
	if (error.kind !== 'key') return error.message;
	const text = pyRepr(error.message);
	let start = 0;
	let end = text.length;
	while (start < end && (text[start] === "'" || text[start] === '"')) start++;
	while (end > start && (text[end - 1] === "'" || text[end - 1] === '"')) end--;
	return text.slice(start, end);
}
