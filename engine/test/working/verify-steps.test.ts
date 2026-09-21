import { describe, expect, it } from 'vitest';
import { drain, type WorkingCopy } from '../../src/index.ts';
import { family } from '../model/fixtures.ts';
import { workingCopy } from './helpers.ts';

function edited(): WorkingCopy {
	const wc = workingCopy(family(), 4);
	wc.stage([{ kind: 'update_element', id: 'a', properties_patch: { name: 'Z' } }]);
	wc.stage([{ kind: 'delete_element', id: 'c' }]);
	wc.stage([
		{ kind: 'create_element', temp_id: 'tmp_new', type_name: 'Node', properties: { name: 'N' } },
		{
			kind: 'create_relationship',
			temp_id: 'tmp_rel',
			type_name: 'Contains',
			source_id: 'd',
			target_id: 'tmp_new'
		}
	]);
	return wc;
}

describe('the digest check in steps', () => {
	it('holds on a fresh replica', () => {
		const wc = workingCopy(family(), 4);
		expect(drain(wc.verifyDigestSteps())).toBe(true);
		expect(wc.verifyDigest()).toBe(true);
		expect(wc.diverged).toBe(false);
	});

	it('holds with staged batches that update, delete and create', () => {
		const wc = edited();
		expect(drain(wc.verifyDigestSteps())).toBe(true);
		expect(wc.diverged).toBe(false);
	});

	it('fails once a committed rev is tampered with, and only then sets diverged', () => {
		const wc = edited();
		wc.model.getElement('b').rev += 1;
		expect(wc.diverged).toBe(false);
		expect(drain(wc.verifyDigestSteps())).toBe(false);
		expect(wc.diverged).toBe(true);
	});

	it('publishes nothing when abandoned after its first step', () => {
		const wc = edited();
		wc.model.getElement('b').rev += 1;
		const steps = wc.verifyDigestSteps();
		expect(steps.next().done).toBe(false);
		expect(wc.diverged).toBe(false);
	});

	it('counts every entity and every committed image', () => {
		const wc = edited();
		let last = { done: 0, total: 0 };
		const steps = wc.verifyDigestSteps();
		for (let next = steps.next(); next.done !== true; next = steps.next()) last = next.value;
		const images = 3 + 2;
		const total = wc.model.elementCount + wc.model.relationshipCount + images;
		expect(last).toEqual({ done: total, total });
	});
});
