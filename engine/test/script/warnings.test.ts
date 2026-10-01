import { describe, expect, it } from 'vitest';
import { MAX_SCRIPT_WARNINGS, ScriptWarningLog } from '../../src/index.ts';

describe('the warnings channel', () => {
	it('aggregates by code and detail, in first-seen order', () => {
		const log = new ScriptWarningLog();
		log.add('nav_step_failed', 'x');
		log.add('nav_snippet_not_found', 'x');
		log.add('nav_step_failed', 'x');
		log.add('nav_step_failed', null);
		log.add('nav_step_failed', 'x', 5);
		expect(log.entries).toEqual([
			{ code: 'nav_step_failed', occurrences: 3, total: 5, detail: 'x' },
			{ code: 'nav_snippet_not_found', occurrences: 1, total: 0, detail: 'x' },
			{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: null }
		]);
	});

	it('holds a bounded number of kinds and keeps counting the ones it has', () => {
		const log = new ScriptWarningLog();
		for (let i = 0; i < MAX_SCRIPT_WARNINGS + 5; i++) log.add('nav_step_failed', `kind ${i}`);
		log.add('nav_step_failed', 'kind 0');
		log.add('nav_step_failed', `kind ${MAX_SCRIPT_WARNINGS + 1}`);
		expect(log.entries).toHaveLength(MAX_SCRIPT_WARNINGS);
		expect(log.entries[0]!.occurrences).toBe(2);
		expect(log.entries.map((w) => w.detail)).not.toContain(`kind ${MAX_SCRIPT_WARNINGS + 1}`);
	});

	it('reads what was added since a snapshot, as counts, in the log order', () => {
		const log = new ScriptWarningLog();
		log.add('nav_step_failed', 'old');
		log.add('nav_snippet_not_found', 'kept');
		const before = log.snapshot();
		log.add('nav_snippet_not_found', 'kept');
		log.add('nav_step_failed', 'new', 2);
		log.add('nav_step_failed', 'old');
		log.add('nav_step_failed', 'old');
		expect(log.since(before)).toEqual([
			{ code: 'nav_step_failed', occurrences: 2, total: 0, detail: 'old' },
			{ code: 'nav_snippet_not_found', occurrences: 1, total: 0, detail: 'kept' },
			{ code: 'nav_step_failed', occurrences: 1, total: 2, detail: 'new' }
		]);
		expect(log.since(log.snapshot())).toEqual([]);
	});
});
