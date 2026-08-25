/**
 * Snippet-run wrapper over `stageProposedOps`: the run's own `stale` flag
 * (a commit landed mid-run) is refused before the rev check.
 */
import type { SnippetRunOut } from '$lib/api/snippets';
import { stageProposedOps, type StageOutcome } from './stage-proposed';

export type { StageOutcome };

export async function stageSnippetOps(result: SnippetRunOut): Promise<StageOutcome> {
	if (result.ops.length === 0) return { ok: false, reason: 'empty' };
	if (result.stale) return { ok: false, reason: 'stale' };
	return stageProposedOps(result.ops, result.model_rev);
}
