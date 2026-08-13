import { describe, expect, it } from 'vitest';
import {
	KIND_ICONS,
	KIND_LABEL,
	REGISTERED_KINDS,
	SECTION_KINDS,
	isRegisteredKind
} from '../kinds';

describe('artifact kind registry', () => {
	it('icon and label maps are total over the registered kinds', () => {
		for (const k of REGISTERED_KINDS) {
			expect(KIND_ICONS[k]).toBeTruthy();
			expect(KIND_LABEL[k]).toBeTruthy();
		}
	});
	it('rejects unregistered kinds', () => {
		expect(isRegisteredKind('diagram')).toBe(false);
		expect(SECTION_KINDS.has('diagram_kind')).toBe(false);
	});
});
