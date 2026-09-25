import type { RulesParse, WireStagedArtifact } from '$engine';
import type { RulesParseOut } from '$lib/api/types';

export const RULES_KIND = 'validation_rules';

export type RulesParser = {
	/**
	 * `entries` with `rules` set on every create, or update with a payload, of
	 * a rule set: the parse of its YAML, or `'pending'` while it is out. An
	 * update's kind is `kindOf(id)`. A pending text starts one parse, however
	 * many entries carry it; a parse that was not answered is asked again here.
	 */
	attach(
		entries: readonly WireStagedArtifact[],
		kindOf: (id: string) => string | undefined
	): WireStagedArtifact[];
	/** `listener` is told whenever a parse lands; the returned function unsubscribes. */
	onParsed(listener: () => void): () => void;
	/** Whether a parse is out. */
	busy(): boolean;
	/** Resolves once no parse is out. */
	settled(): Promise<void>;
};

/**
 * The server's parse as the engine reads it, the document the text it came
 * as; `null` for a body that is no parse.
 */
export function engineParse(out: RulesParseOut): RulesParse | null {
	if (out.ok) return out.document === null ? null : { ok: true, document: out.document };
	return out.errors.length === 0 ? null : { ok: false, errors: out.errors };
}

/** The YAML the server parses for a rule set's payload: a payload without one is an empty set. */
function yamlOf(payload: { [key: string]: unknown }): string {
	const yaml = payload['yaml'];
	return typeof yaml === 'string' ? yaml : '';
}

/**
 * Parses the staged rule sets' YAML through `parse` (`POST /rules/parse`),
 * once per distinct text. Nothing is retried on its own: a parse that fails
 * or answers a body that is no parse is forgotten, and the next `attach` of
 * its text asks again. Only the texts the last `attach` named are kept.
 */
export function createRulesParser(parse: (yaml: string) => Promise<RulesParseOut>): RulesParser {
	const parses = new Map<string, RulesParse>();
	const out = new Set<string>();
	let wanted = new Set<string>();
	const listeners = new Set<() => void>();
	const idle: (() => void)[] = [];

	const start = (yaml: string) => {
		out.add(yaml);
		void parse(yaml)
			.then(engineParse, () => null)
			.then((landed) => {
				out.delete(yaml);
				try {
					if (landed === null || !wanted.has(yaml)) return;
					parses.set(yaml, landed);
					for (const listener of [...listeners]) listener();
				} finally {
					if (out.size === 0) for (const resolve of idle.splice(0)) resolve();
				}
			});
	};

	const textOf = (
		entry: WireStagedArtifact,
		kindOf: (id: string) => string | undefined
	): string | undefined => {
		if (entry.op === 'create') return entry.kind === RULES_KIND ? yamlOf(entry.payload) : undefined;
		if (entry.op === 'delete' || entry.payload === undefined) return undefined;
		return kindOf(entry.id) === RULES_KIND ? yamlOf(entry.payload) : undefined;
	};

	return {
		attach(entries, kindOf) {
			wanted = new Set();
			const attached = entries.map((entry): WireStagedArtifact => {
				const yaml = textOf(entry, kindOf);
				if (yaml === undefined || entry.op === 'delete') return entry;
				wanted.add(yaml);
				const parsed = parses.get(yaml);
				if (parsed !== undefined) return { ...entry, rules: parsed };
				if (!out.has(yaml)) start(yaml);
				return { ...entry, rules: 'pending' };
			});
			for (const yaml of parses.keys()) if (!wanted.has(yaml)) parses.delete(yaml);
			return attached;
		},

		onParsed(listener) {
			const entry = () => listener();
			listeners.add(entry);
			return () => {
				listeners.delete(entry);
			};
		},

		busy() {
			return out.size > 0;
		},

		settled() {
			if (out.size === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idle.push(resolve));
		}
	};
}
