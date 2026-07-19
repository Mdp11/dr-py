import { describe, expect, it } from 'vitest';
import { ENTRY_HINTS, entryAvailable, withStub } from '../entry-stubs';

describe('entryAvailable', () => {
	it('script is always available, even before lint responds', () => {
		expect(entryAvailable('script', undefined)).toBe(true);
		expect(entryAvailable('script', [])).toBe(true);
	});

	it('value/step require the lint-derived entry list', () => {
		expect(entryAvailable('value', undefined)).toBe(false);
		expect(entryAvailable('value', ['script'])).toBe(false);
		expect(entryAvailable('value', ['script', 'value'])).toBe(true);
		expect(entryAvailable('step', ['script', 'step'])).toBe(true);
	});
});

describe('withStub', () => {
	it('an empty document gets just the stub', () => {
		const out = withStub('', 'value');
		expect(out).toMatch(/^def value\(elements\):/);
		expect(out.endsWith('\n')).toBe(true);
	});

	it('existing code keeps a blank-line separator before the stub', () => {
		const out = withStub('print(1)\n', 'step');
		expect(out).toContain('print(1)\n\n\ndef step(el):');
	});

	it('the stub defines the one-arg function lint derives entry points from', () => {
		// Mirrors core/script/lint.derive_entry_points: top-level def, one arg.
		expect(withStub('', 'value')).toContain('def value(elements):');
		expect(withStub('', 'step')).toContain('def step(el):');
	});
});

describe('ENTRY_HINTS', () => {
	it('names the required function signature per entry', () => {
		expect(ENTRY_HINTS.value).toContain('def value(elements):');
		expect(ENTRY_HINTS.step).toContain('def step(el):');
	});
});
