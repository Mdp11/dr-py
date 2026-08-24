import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { MetamodelLintErrorSchema } from './types';

/** One rules-lint finding. Position is best-effort and 1-based: only a YAML
 * PARSE error carries a line/column (from the parser mark); a schema violation
 * is message-only.
 *
 * The metamodel linter answers the same shape off the same server-side model,
 * so the two share ONE schema rather than two copies that can drift. */
export const RulesLintErrorSchema = MetamodelLintErrorSchema;
export type RulesLintError = z.infer<typeof RulesLintErrorSchema>;

/** Drift: a rule naming a stereotype, relationship or property the metamodel
 * does not have. A WARNING, never an error — the metamodel can change under a
 * committed rule set, so a drifted rule is skipped, not invalid. */
export const RulesLintWarningSchema = z.object({
	rule: z.string(),
	message: z.string()
});
export type RulesLintWarning = z.infer<typeof RulesLintWarningSchema>;

export const RulesLintSchema = z.object({
	ok: z.boolean(),
	errors: z.array(RulesLintErrorSchema).default([]),
	warnings: z.array(RulesLintWarningSchema).default([])
});
export type RulesLint = z.infer<typeof RulesLintSchema>;

/**
 * Parse + schema + drift check for the rules editor's debounced calls.
 *
 * Sibling of `lintMetamodel`, with one difference that matters to callers: the
 * YAML rides in a JSON ENVELOPE rather than being the raw body, so any lint
 * RESULT (unparseable, schema-violating, drifted) comes back 200 while a
 * rejected envelope is a 422 — in practice a document past the server's size
 * cap, since the envelope itself is always well-formed here.
 */
export function lintRules(yaml: string, cfg?: ClientConfig): Promise<RulesLint> {
	return apiFetch('/rules/lint', { method: 'POST', body: { yaml }, schema: RulesLintSchema }, cfg);
}
