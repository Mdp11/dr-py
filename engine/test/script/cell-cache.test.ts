import { describe, expect, it } from 'vitest';
import {
	CELL_CACHE_LIMITS,
	CellCache,
	cellKey,
	readKeyText,
	type CellCacheLimits
} from '../../src/script/cell-cache.ts';
import type { ReadKey, ScriptErrorKind, ScriptResult } from '../../src/script/result.ts';

const limits = (over: Partial<CellCacheLimits> = {}): CellCacheLimits => ({
	...CELL_CACHE_LIMITS,
	...over
});

const value = (reads: readonly ReadKey[] | null = []): ScriptResult => ({
	payload: { kind: 'scalar', value: 1 },
	error: null,
	reads,
	stdout: ''
});

const failed = (kind: string): ScriptResult => ({
	payload: null,
	error: { kind: kind as ScriptErrorKind, message: 'm', traceback: null },
	reads: null,
	stdout: ''
});

// A result text that makes the key and the text together `units` UTF-16 units.
const sized = (key: string, units: number) => 'x'.repeat(units - key.length);

const reading = (...keys: ReadKey[]) => value(keys);

const touching = (...keys: ReadKey[]) => new Set(keys.map(readKeyText));

describe('the keys', () => {
	it('writes a read key with its id after a NUL and a null id as a lone SOH', () => {
		expect(readKeyText(['el', 'a1'])).toBe('el\u0000a1');
		expect(readKeyText(['scan', null])).toBe('scan\u0001');
		expect(readKeyText(['scan', 'null'])).not.toBe(readKeyText(['scan', null]));
		expect(readKeyText(['el', ''])).not.toBe(readKeyText(['el', null]));
	});

	it('writes a tag the guest invented as it is', () => {
		const odd = ['bogus', 'a'] as unknown as ReadKey;
		expect(readKeyText(odd)).toBe('bogus\u0000a');
		expect(readKeyText(['bogus', null] as unknown as ReadKey)).toBe('bogus\u0001');
	});

	it('tells every part of a call apart', () => {
		const base = cellKey('def value(e): pass', 'value', ['a', 'b'], null, null);
		expect(cellKey('def value(e): pass', 'value', ['a', 'b'], null, null)).toBe(base);
		const others = [
			cellKey('def value(e): pass ', 'value', ['a', 'b'], null, null),
			cellKey('def value(e): pass', 'step', ['a', 'b'], null, null),
			cellKey('def value(e): pass', 'value', ['a'], null, null),
			cellKey('def value(e): pass', 'value', ['ab'], null, null),
			cellKey('def value(e): pass', 'value', ['b', 'a'], null, null),
			cellKey('def value(e): pass', 'value', ['a', 'b'], '{}', null),
			cellKey('def value(e): pass', 'value', ['a', 'b'], null, '{}'),
			cellKey('def value(e): pass', 'value', ['a', 'b'], 'null', null)
		];
		expect(new Set([base, ...others]).size).toBe(others.length + 1);
	});
});

describe('the recency order', () => {
	it('drops the least recently used entry first, and a get makes an entry recent', () => {
		const cache = new CellCache(limits({ entries: 3 }));
		for (const k of ['a', 'b', 'c']) cache.put(k, value(), '{}');
		expect(cache.get('a')).toBeDefined();
		cache.put('d', value(), '{}');
		expect(cache.get('b')).toBeUndefined();
		expect(['a', 'c', 'd'].map((k) => cache.get(k) !== undefined)).toEqual([true, true, true]);
		cache.put('e', value(), '{}');
		// a, c, d were read in that order after d went in: a is now the oldest
		expect(cache.get('a')).toBeUndefined();
		expect(cache.size).toBe(3);
	});

	it('answers the stored result itself', () => {
		const cache = new CellCache();
		const result = value([['el', 'a']]);
		cache.put('k', result, '{}');
		expect(cache.get('k')).toBe(result);
		expect(cache.get('absent')).toBeUndefined();
	});

	it('puts a key stored again at the recent end, once, with its new size', () => {
		const cache = new CellCache(limits({ entries: 2 }));
		cache.put('a', value(), sized('a', 10));
		cache.put('b', value(), sized('b', 10));
		cache.put('a', value(), sized('a', 30));
		expect(cache.size).toBe(2);
		expect(cache.bytes).toBe(80);
		cache.put('c', value(), sized('c', 10));
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('a')).toBeDefined();
	});
});

describe('the bounds', () => {
	it('stops at the entry cap', () => {
		const cache = new CellCache(limits({ entries: 2 }));
		for (const k of ['a', 'b', 'c', 'd']) cache.put(k, value(), '{}');
		expect(cache.size).toBe(2);
		expect([cache.get('a'), cache.get('b')]).toEqual([undefined, undefined]);
		expect(cache.get('c')).toBeDefined();
		expect(cache.get('d')).toBeDefined();
	});

	it('counts two bytes per UTF-16 unit and drops least recent first at the byte cap', () => {
		const cache = new CellCache(limits({ bytes: 200 }));
		cache.put('a', value(), sized('a', 40));
		cache.put('b', value(), sized('b', 40));
		expect(cache.bytes).toBe(160);
		cache.get('a');
		cache.put('c', value(), sized('c', 40));
		expect(cache.get('b')).toBeUndefined();
		expect(cache.bytes).toBe(160);
		// 160 + 160 > 200: a goes as the older of a and c, and 240 is still over: c goes too
		cache.put('d', value(), sized('d', 80));
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('c')).toBeUndefined();
		expect(cache.get('d')).toBeDefined();
		expect(cache.bytes).toBe(160);
	});

	it('stores a result of exactly the entry size and refuses one unit more', () => {
		const cache = new CellCache(limits({ entryBytes: 100 }));
		cache.put('fits', value(), sized('fits', 50));
		cache.put('over', value(), sized('over', 51));
		expect(cache.get('fits')).toBeDefined();
		expect(cache.get('over')).toBeUndefined();
		expect(cache.size).toBe(1);
		expect(cache.bytes).toBe(100);
	});

	it('keeps the stored entry when a larger result for the same key is refused', () => {
		const cache = new CellCache(limits({ entryBytes: 100 }));
		const first = value();
		cache.put('k', first, sized('k', 10));
		cache.put('k', value(), sized('k', 51));
		expect(cache.get('k')).toBe(first);
	});

	it('counts the key against the entry size', () => {
		const cache = new CellCache(limits({ entryBytes: 100 }));
		const key = 'k'.repeat(40);
		cache.put(key, value(), 'x'.repeat(10));
		cache.put('j'.repeat(41), value(), 'x'.repeat(10));
		expect(cache.get(key)).toBeDefined();
		expect(cache.get('j'.repeat(41))).toBeUndefined();
		expect(cache.bytes).toBe(100);
	});

	it('counts the key against the byte cap', () => {
		const cache = new CellCache(limits({ bytes: 150 }));
		const [a, b, c] = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)] as const;
		cache.put(a, value(), 'x');
		cache.put(b, value(), 'x');
		expect(cache.bytes).toBe(124);
		// the texts alone are 6 bytes, the keys make the third overflow
		cache.put(c, value(), 'x');
		expect(cache.get(a)).toBeUndefined();
		expect(cache.get(b)).toBeDefined();
		expect(cache.get(c)).toBeDefined();
		expect(cache.bytes).toBe(124);
	});

	it('refuses a 64 KiB result by default', () => {
		const cache = new CellCache();
		cache.put('fits', value(), sized('fits', 32 * 1024));
		cache.put('over', value(), sized('over', 32 * 1024 + 1));
		expect(cache.size).toBe(1);
	});
});

describe('which results are stored', () => {
	it.each(['runtime', 'syntax'])('stores a %s error', (kind) => {
		const cache = new CellCache();
		const result = failed(kind);
		cache.put('k', result, '{}');
		expect(cache.get('k')).toBe(result);
	});

	it.each(['timeout', 'cancelled', 'memory', 'unavailable', 'pending', 'limit', 'invented'])(
		'does not store a %s error',
		(kind) => {
			const cache = new CellCache();
			cache.put('k', failed(kind), '{}');
			expect(cache.get('k')).toBeUndefined();
			expect(cache.size).toBe(0);
			expect(cache.bytes).toBe(0);
		}
	);

	it('stores a value', () => {
		const cache = new CellCache();
		cache.put('k', value(), '{}');
		expect(cache.size).toBe(1);
	});
});

describe('eviction by read-set', () => {
	it('drops exactly the entries that read a touched key and counts them', () => {
		const cache = new CellCache();
		cache.put('a', reading(['el', 'x'], ['out', 'y']), '{}');
		cache.put('b', reading(['el', 'z']), '{}');
		cache.put('c', reading(['out', 'y'], ['in', 'w']), '{}');
		cache.put('d', reading(['scan', null]), '{}');
		cache.put('e', value([]), '{}');
		expect(cache.evict(touching(['out', 'y'], ['scan', null], ['el', 'nobody']))).toBe(3);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('c')).toBeUndefined();
		expect(cache.get('d')).toBeUndefined();
		expect(cache.get('b')).toBeDefined();
		expect(cache.get('e')).toBeDefined();
		expect(cache.size).toBe(2);
	});

	it('tells a null id from an empty one and a tag from another with the same id', () => {
		const cache = new CellCache();
		cache.put('null', reading(['scan', null]), '{}');
		cache.put('empty', reading(['scan', '']), '{}');
		cache.put('other', reading(['el', '']), '{}');
		expect(cache.evict(touching(['scan', '']))).toBe(1);
		expect(cache.get('empty')).toBeUndefined();
		expect(cache.get('null')).toBeDefined();
		expect(cache.get('other')).toBeDefined();
	});

	it('leaves an entry that reads a key no other transition touched', () => {
		const cache = new CellCache();
		cache.put('a', reading(['el', 'x']), sized('a', 10));
		expect(cache.evict(touching(['el', 'y']))).toBe(0);
		expect(cache.size).toBe(1);
		expect(cache.bytes).toBe(20);
	});

	it('counts an entry that read several touched keys once', () => {
		const cache = new CellCache();
		cache.put('a', reading(['el', 'x'], ['el', 'y']), '{}');
		expect(cache.evict(touching(['el', 'x'], ['el', 'y']))).toBe(1);
		expect(cache.size).toBe(0);
	});

	it('takes the entries it drops out of the byte count', () => {
		const cache = new CellCache();
		cache.put('a', reading(['el', 'x']), sized('a', 10));
		cache.put('b', reading(['el', 'y']), sized('b', 30));
		cache.evict(touching(['el', 'x']));
		expect(cache.bytes).toBe(60);
	});

	it('does not count an entry the bounds already dropped', () => {
		const cache = new CellCache(limits({ entries: 1 }));
		cache.put('a', reading(['el', 'x']), '{}');
		cache.put('b', reading(['el', 'y']), '{}');
		expect(cache.evict(touching(['el', 'x']))).toBe(0);
		expect(cache.size).toBe(1);
		expect(cache.evict(touching(['el', 'y']))).toBe(1);
	});

	it('does not leave an entry a key stored again replaced reachable by its old reads', () => {
		const cache = new CellCache();
		cache.put('a', reading(['el', 'x']), '{}');
		cache.put('a', reading(['el', 'y']), '{}');
		expect(cache.evict(touching(['el', 'x']))).toBe(0);
		expect(cache.get('a')).toBeDefined();
		expect(cache.evict(touching(['el', 'y']))).toBe(1);
	});

	it('drops every entry that depends on everything, whatever was touched', () => {
		const cache = new CellCache();
		cache.put('unknown', value(null), '{}');
		cache.put('errored', failed('runtime'), '{}');
		cache.put('reads', reading(['el', 'x']), '{}');
		expect(cache.evict(touching(['el', 'nobody']))).toBe(2);
		expect(cache.get('unknown')).toBeUndefined();
		expect(cache.get('errored')).toBeUndefined();
		expect(cache.get('reads')).toBeDefined();
	});

	it('stores a read-set of the bound as it is and one key more as everything', () => {
		const keys = (n: number): ReadKey[] => Array.from({ length: n }, (_, i) => ['el', `k${i}`]);
		const cache = new CellCache();
		cache.put('exact', value(keys(128)), '{}');
		cache.put('over', value(keys(129)), '{}');
		expect(cache.evict(touching(['el', 'nobody']))).toBe(1);
		expect(cache.get('over')).toBeUndefined();
		expect(cache.get('exact')).toBeDefined();
		expect(cache.evict(touching(['el', 'k127']))).toBe(1);
	});

	it('stores a read-set above the bound as everything whichever keys it holds', () => {
		const cache = new CellCache(limits({ reads: 2 }));
		cache.put('over', reading(['el', 'a'], ['el', 'b'], ['el', 'c']), '{}');
		expect(cache.evict(touching(['el', 'unrelated']))).toBe(1);
	});

	it('counts a key read twice once against the bound', () => {
		const cache = new CellCache(limits({ reads: 2 }));
		cache.put('a', reading(['el', 'a'], ['el', 'a'], ['el', 'b']), '{}');
		expect(cache.evict(touching(['el', 'nobody']))).toBe(0);
	});

	it('matches a tag the guest invented only against a key of that text', () => {
		const cache = new CellCache();
		cache.put('a', reading(['bogus', 'x'] as unknown as ReadKey), '{}');
		expect(cache.evict(touching(['el', 'x'], ['scan', null], ['children', 'x']))).toBe(0);
		expect(cache.evict(touching(['bogus', 'x'] as unknown as ReadKey))).toBe(1);
	});
});

describe('the work an eviction may spend', () => {
	it('drops the entries one by one while their read-sets fit the budget', () => {
		const cache = new CellCache(limits({ evictWork: 6 }));
		cache.put('a', reading(['el', 'x'], ['el', 'y']), '{}');
		cache.put('b', reading(['el', 'x']), '{}');
		cache.put('c', reading(['el', 'z']), '{}');
		// Three for the first, two for the second.
		expect(cache.evict(touching(['el', 'x']))).toBe(2);
		expect(cache.size).toBe(1);
		expect(cache.get('c')).toBeDefined();
	});

	it('clears the cache, answering what it held, when they would pass it', () => {
		const cache = new CellCache(limits({ evictWork: 4 }));
		cache.put('a', reading(['el', 'x'], ['el', 'y']), '{}');
		cache.put('b', reading(['el', 'x']), '{}');
		cache.put('c', reading(['el', 'z']), '{}');
		expect(cache.evict(touching(['el', 'x']))).toBe(3);
		expect(cache.size).toBe(0);
		expect(cache.bytes).toBe(0);
		cache.put('d', reading(['el', 'x']), '{}');
		expect(cache.evict(touching(['el', 'x']))).toBe(1);
	});

	it('keeps the bound for entries that each read 128 keys: 700 are dropped one by one, 1,000 clear the cache', () => {
		const keys: ReadKey[] = Array.from({ length: 128 }, (_, i) => ['el', `k${i}`]);
		const filled = (readers: number) => {
			const cache = new CellCache();
			for (let i = 0; i < readers; i++) cache.put(`call ${i}`, value(keys), '{}');
			cache.put('other', reading(['el', 'other']), '{}');
			return cache;
		};
		const some = filled(700);
		expect(some.evict(touching(['el', 'k0']))).toBe(700);
		expect(some.size).toBe(1);
		expect(some.get('other')).toBeDefined();
		const many = filled(1_000);
		expect(many.evict(touching(['el', 'k0']))).toBe(1_001);
		expect(many.size).toBe(0);
		expect(many.bytes).toBe(0);
	});
});

describe('clearing', () => {
	it('empties the cache and its byte count, and takes nothing after', () => {
		const cache = new CellCache();
		cache.put('a', reading(['el', 'x']), sized('a', 10));
		cache.put('b', value(null), sized('b', 10));
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.bytes).toBe(0);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.evict(touching(['el', 'x']))).toBe(0);
		cache.put('c', reading(['el', 'x']), '{}');
		expect(cache.evict(touching(['el', 'x']))).toBe(1);
	});
});
