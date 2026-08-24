/**
 * Rules editor state — placeholder. The `validation_rules` sibling of
 * `exporter-editor.svelte.ts` (draft store, lease/staging model, dirty
 * tracking) does not exist yet; these no-op stubs exist only so the kind
 * registration compiles — Workspace.svelte's close dispatch needs
 * `closeRulesDraft` to exist.
 */
export function ensureRulesDraft(tabId: string): Promise<void> {
	void tabId;
	return Promise.resolve();
}

export function closeRulesDraft(tabId: string): void {
	void tabId; // no-op: no draft store yet
}

export function resetRulesEditors(): void {
	// no-op: no draft store yet
}
