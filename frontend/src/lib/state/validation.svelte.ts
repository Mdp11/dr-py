import type { Issue } from '$lib/api/types';

let _issues: Issue[] = $state([]);
let _lastRunAt: number | null = $state(null);
let _running: boolean = $state(false);
let _lastError: string | null = $state(null);

export function getIssues(): readonly Issue[] {
	return _issues;
}

export function getLastRunAt(): number | null {
	return _lastRunAt;
}

export function isRunning(): boolean {
	return _running;
}

export function getLastError(): string | null {
	return _lastError;
}

export function setIssues(issues: Issue[]): void {
	_issues = issues;
	_lastRunAt = Date.now();
	_lastError = null;
}

export function setRunning(b: boolean): void {
	_running = b;
}

export function setLastError(message: string | null): void {
	_lastError = message;
}

export function clearIssues(): void {
	_issues = [];
	_lastRunAt = null;
	_lastError = null;
}
