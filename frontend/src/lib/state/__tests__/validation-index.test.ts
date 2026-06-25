import { describe, expect, it } from 'vitest';
import type { Issue } from '$lib/api/types';
import { indexIssues, worstSeverityFor } from '../validation-index';

function issue(severity: 'error' | 'warning', message: string, target_ids: string[]): Issue {
	return { severity, message, target_ids, origin: 'on_server' };
}

describe('indexIssues', () => {
	it('returns empty index for no issues', () => {
		const idx = indexIssues([]);
		expect(idx.byEntity.size).toBe(0);
		expect(idx.errorIds.size).toBe(0);
		expect(idx.warningIds.size).toBe(0);
	});

	it('bundles multiple issues per target', () => {
		const a = issue('error', 'missing name', ['e1']);
		const b = issue('warning', 'unused', ['e1']);
		const idx = indexIssues([a, b]);
		expect(idx.byEntity.get('e1')).toEqual([a, b]);
		expect(idx.errorIds.has('e1')).toBe(true);
		expect(idx.warningIds.has('e1')).toBe(true);
	});

	it('spreads issue with multiple targets across each id', () => {
		const a = issue('error', 'dangling ref', ['e1', 'e2', 'r1']);
		const idx = indexIssues([a]);
		expect(idx.byEntity.get('e1')).toEqual([a]);
		expect(idx.byEntity.get('e2')).toEqual([a]);
		expect(idx.byEntity.get('r1')).toEqual([a]);
		expect(idx.errorIds.size).toBe(3);
	});

	it('separates error and warning buckets', () => {
		const idx = indexIssues([issue('error', 'x', ['e1']), issue('warning', 'y', ['e2'])]);
		expect(idx.errorIds.has('e1')).toBe(true);
		expect(idx.errorIds.has('e2')).toBe(false);
		expect(idx.warningIds.has('e2')).toBe(true);
		expect(idx.warningIds.has('e1')).toBe(false);
	});

	it('handles an issue with empty target_ids without crashing', () => {
		const idx = indexIssues([issue('error', 'global', [])]);
		expect(idx.byEntity.size).toBe(0);
		expect(idx.errorIds.size).toBe(0);
	});
});

describe('worstSeverityFor', () => {
	it('returns null when id has no issues', () => {
		const idx = indexIssues([]);
		expect(worstSeverityFor(idx, 'unknown')).toBeNull();
	});

	it('returns "error" when id has an error (even with warnings too)', () => {
		const idx = indexIssues([issue('error', 'x', ['e1']), issue('warning', 'y', ['e1'])]);
		expect(worstSeverityFor(idx, 'e1')).toBe('error');
	});

	it('returns "warning" when id has only warnings', () => {
		const idx = indexIssues([issue('warning', 'y', ['e1'])]);
		expect(worstSeverityFor(idx, 'e1')).toBe('warning');
	});
});
