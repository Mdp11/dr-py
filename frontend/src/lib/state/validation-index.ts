import type { Issue } from '$lib/api/types';

export interface IssueIndex {
	byEntity: Map<string, Issue[]>;
	errorIds: Set<string>;
	warningIds: Set<string>;
}

export function indexIssues(issues: readonly Issue[]): IssueIndex {
	const byEntity = new Map<string, Issue[]>();
	const errorIds = new Set<string>();
	const warningIds = new Set<string>();
	for (const issue of issues) {
		for (const id of issue.target_ids) {
			const arr = byEntity.get(id) ?? [];
			arr.push(issue);
			byEntity.set(id, arr);
			if (issue.severity === 'error') errorIds.add(id);
			else warningIds.add(id);
		}
	}
	return { byEntity, errorIds, warningIds };
}

export function worstSeverityFor(index: IssueIndex, id: string): 'error' | 'warning' | null {
	if (index.errorIds.has(id)) return 'error';
	if (index.warningIds.has(id)) return 'warning';
	return null;
}
