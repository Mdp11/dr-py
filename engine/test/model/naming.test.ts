import { expect, it } from 'vitest';
import { displayName, ElementRec, nameOf, type Props } from '../../src/index.ts';

const named = (props: Props) => new ElementRec('the-id', 'T', props, 0, 0);

it('takes the exact lower-case name first, whatever comes before it', () => {
	expect(nameOf(named({ NAME: 'upper', name: 'exact' }))).toBe('exact');
});

it('falls back to other casings in property order', () => {
	expect(nameOf(named({ name: '', NAME: 'upper', Name: 'title' }))).toBe('upper');
	expect(nameOf(named({ nAmE: '', Name: 'title' }))).toBe('title');
	expect(nameOf(named({ names: 'plural', title: 'other' }))).toBeNull();
});

it('reads the first non-empty string of a list', () => {
	expect(nameOf(named({ name: ['', 5, 'second', 'third'] }))).toBe('second');
	expect(nameOf(named({ name: [], Name: ['title'] }))).toBe('title');
});

it('ignores values that are not names and falls back to the id', () => {
	for (const value of [5, true, null, {}, ['', 7]]) {
		expect(nameOf(named({ name: value }))).toBeNull();
		expect(displayName(named({ name: value }))).toBe('the-id');
	}
	expect(displayName(named({ name: 'shown' }))).toBe('shown');
});

it('never reads a name off the prototype chain', () => {
	expect(nameOf(named(Object.create({ name: 'inherited' }) as Props))).toBeNull();
});
