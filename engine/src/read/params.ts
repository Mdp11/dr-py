import { ReadError } from './errors.ts';

/** The parameters of a read, as they cross the port. */
export type ReadParams = { readonly [key: string]: unknown };

/** The cap on `limit`, and on the ids of a batch read. */
export const MAX_PAGE_LIMIT = 500;

export type Direction = 'both' | 'in' | 'out';

const isInteger = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value);

// FastAPI, not the route, bounds a page: these texts are the engine's own.
export function pageOf(params: ReadParams, defaultLimit = 100): { limit: number; offset: number } {
	const { limit = defaultLimit, offset = 0 } = params;
	if (!isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
		throw new ReadError(422, `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
	}
	if (!isInteger(offset) || offset < 0) {
		throw new ReadError(422, 'offset must be an integer of at least 0');
	}
	return { limit, offset };
}

export function directionOf(params: ReadParams): Direction {
	const { direction = 'both' } = params;
	if (direction !== 'both' && direction !== 'in' && direction !== 'out') {
		throw new ReadError(422, "direction must be 'both', 'in' or 'out'");
	}
	return direction;
}

export function idOf(params: ReadParams): string {
	const { id } = params;
	if (typeof id !== 'string') throw new ReadError(422, 'id must be a string');
	return id;
}

export function idsOf(params: ReadParams): readonly string[] {
	const { ids } = params;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
		throw new ReadError(422, 'ids must be a list of strings');
	}
	if (ids.length > MAX_PAGE_LIMIT) {
		throw new ReadError(422, `too many ids: ${ids.length} (max ${MAX_PAGE_LIMIT})`);
	}
	return ids as string[];
}

/** An optional string: absent and `null` are none. */
export function optionalString(params: ReadParams, key: string): string | null {
	const value = params[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw new ReadError(422, `${key} must be a string`);
	return value;
}
