import type { Issue } from '$lib/api/types';

let _issues: Issue[] = $state([]);

export function getIssues(): readonly Issue[] {
	return _issues;
}

export function setIssues(issues: Issue[]): void {
	_issues = issues;
}

export function clearIssues(): void {
	_issues = [];
}
