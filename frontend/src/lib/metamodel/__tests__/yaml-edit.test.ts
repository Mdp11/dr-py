import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDraft, serializeDraft, lineRangeForType } from '../yaml-edit';
import { FIXTURE } from './fixtures';

// The real repo metamodel — read straight off disk (not through Vite's
// module graph) so this test exercises the actual file, not a copy that
// could drift from it. `process.cwd()` is `frontend/` for every path that
// runs this suite: pixi's `frontend-test` task pins `cwd = "frontend"`, and
// `npm --prefix frontend run test` starts npm's own process there too (an
// `import.meta.url`-relative path instead breaks: Vite proxies module URLs
// that resolve outside its root to an `http://` module id, which
// `fileURLToPath` then rejects).
const SMART_CITY_METAMODEL_PATH = resolve(process.cwd(), '../examples/smart-city.metamodel.yaml');

describe('parseDraft', () => {
	it('parses the fixture into the API Metamodel shape', () => {
		const { mm, errors } = parseDraft(FIXTURE);
		expect(errors).toEqual([]);
		expect(mm).not.toBeNull();
		expect(mm!.elements.map((e) => e.name)).toEqual(['NamedElement', 'Zone', 'Building']);
		expect(mm!.enums).toEqual({ Status: ['Draft', 'Active'] });
	});

	it('normalizes shorthand endpoints into mappings', () => {
		const { mm } = parseDraft(FIXTURE);
		const contains = mm!.relationships.find((r) => r.name === 'Contains')!;
		expect(contains.mappings).toEqual([{ source: 'Zone', target: 'Building' }]);
		expect(contains.source).toBe('Zone');
	});

	it('tolerates an abstract relationship with no endpoints at all', () => {
		const { mm } = parseDraft(FIXTURE);
		const observes = mm!.relationships.find((r) => r.name === 'Observes')!;
		expect(observes.mappings).toEqual([]);
	});

	it('reports a line-anchored error for broken syntax and mm stays null', () => {
		const { mm, errors } = parseDraft('elements:\n  - name: [unclosed\n');
		expect(mm).toBeNull();
		expect(errors.length).toBeGreaterThan(0);
	});

	it('round-trips the fixture byte-identically when nothing was edited', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(serializeDraft(doc)).toBe(FIXTURE);
	});
});

describe('round-trip against the real example metamodel', () => {
	// Regression guard for the fixture-vs-reality drift the review caught:
	// the emitter's default flow-collection padding rewrites every
	// `{name: x}` / `[a, b]` in this file on serialize unless
	// `flowCollectionPadding: false` is set. The hand-written FIXTURE above
	// could silently drift from the repo's authored idiom without this
	// checking the genuine article.
	it('round-trips examples/smart-city.metamodel.yaml byte-identically with zero edits', () => {
		const buffer = readFileSync(SMART_CITY_METAMODEL_PATH, 'utf-8');
		const { doc, mm, errors } = parseDraft(buffer);
		expect(errors).toEqual([]);
		expect(mm).not.toBeNull();
		expect(serializeDraft(doc)).toBe(buffer);
	});
});

describe('lineRangeForType', () => {
	it('locates the Zone block', () => {
		const { doc } = parseDraft(FIXTURE);
		const range = lineRangeForType(FIXTURE, doc, 'elements', 'Zone');
		expect(range).not.toBeNull();
		expect(FIXTURE.split('\n')[range!.start - 1]).toContain('name: Zone');
	});

	it('returns null for an unknown type', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(lineRangeForType(FIXTURE, doc, 'elements', 'Nope')).toBeNull();
	});
});
