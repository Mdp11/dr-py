/**
 * Snippet-run wrapper over `stageProposedOps`: the batch is staged only while
 * the working copy still stands where the run began.
 */
import type { SnippetRunOut } from '$lib/api/snippets';
import { stageProposedOps, type StageOutcome } from './stage-proposed';

export type { StageOutcome };

export async function stageSnippetOps(result: SnippetRunOut): Promise<StageOutcome> {
	if (result.ops.length === 0) return { ok: false, reason: 'empty' };
	return stageProposedOps(result.ops, result.stamp);
}
