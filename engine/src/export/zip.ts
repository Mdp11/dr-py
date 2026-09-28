/**
 * Zips a split export's files, a port of `table_export_engine.build_zip`.
 * `fflate` is the engine's one runtime dependency: pure JS, its sync API
 * spawns no workers, so `src/`'s no-Node-no-DOM rule holds.
 */
import { zipSync, type Zippable } from 'fflate';

export type ZipFile = { path: string; bytes: Uint8Array };

/** Every DOS date/time a member carries: 1980-01-01 00:00, the oracle's fixed stamp. */
const MTIME = new Date(1980, 0, 1);

/**
 * Whether `key` is a JS array-index string: JS objects list such keys first,
 * in numeric order, ahead of every other key's insertion order — which would
 * silently reorder a `Zippable`'s members. Every path this module is given
 * carries an extension, so none is integer-like in practice.
 */
function isArrayIndex(key: string): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
	return Number(key) < 2 ** 32 - 1;
}

/**
 * `files` zipped in the given order: `zlib` level 6, every member's modified
 * time 1980-01-01 00:00 in EVERY time zone. `fflate` reads a `Date` mtime
 * through its LOCAL getters, so the fixed `Date(1980, 0, 1)` above — never a
 * string or an epoch number, which would shift with the zone — gives the
 * same DOS date/time everywhere.
 */
export function zipEntries(files: readonly ZipFile[]): Uint8Array {
	const data: Zippable = {};
	for (const { path, bytes } of files) {
		if (isArrayIndex(path)) throw new Error(`zip entry path looks like an array index: ${path}`);
		data[path] = [bytes, { level: 6, mtime: MTIME }];
	}
	return zipSync(data);
}
