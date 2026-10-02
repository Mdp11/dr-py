/**
 * The warnings channel of `core/script/warnings.py`: what an evaluation that
 * degrades instead of failing tells the user, as data. Warnings aggregate by
 * `(code, detail)`, each kind counting its occurrences.
 */

/** The degradations an evaluation reports. */
export type ScriptWarningCode =
	'nav_snippet_not_found' | 'nav_step_failed' | 'sort_needs_script_nav';

/**
 * One aggregated kind, in the field order of the wire. `total` sums the
 * subject quantity a kind carries and stays 0 for the kinds that have none.
 */
export type ScriptWarning = {
	readonly code: ScriptWarningCode;
	readonly occurrences: number;
	readonly total: number;
	readonly detail: string | null;
};

/** The distinct kinds held at once. */
export const MAX_SCRIPT_WARNINGS = 20;

/** The counts of a log, to read what was added since. */
export type WarningSnapshot = ReadonlyMap<string, readonly [number, number]>;

const keyOf = (code: string, detail: string | null) => JSON.stringify([code, detail]);

/** Warnings in first-seen order. */
export class ScriptWarningLog {
	private readonly byKey = new Map<string, ScriptWarning>();

	/**
	 * Records one occurrence. Past `MAX_SCRIPT_WARNINGS` kinds a new kind is
	 * dropped, and the kinds held keep counting.
	 */
	add(code: ScriptWarningCode, detail: string | null = null, count = 0): void {
		const key = keyOf(code, detail);
		const held = this.byKey.get(key);
		if (held !== undefined) {
			this.byKey.set(key, {
				code,
				occurrences: held.occurrences + 1,
				total: held.total + count,
				detail
			});
		} else if (this.byKey.size < MAX_SCRIPT_WARNINGS) {
			this.byKey.set(key, { code, occurrences: 1, total: count, detail });
		}
	}

	get entries(): ScriptWarning[] {
		return [...this.byKey.values()];
	}

	snapshot(): WarningSnapshot {
		return new Map(
			[...this.byKey].map(([key, w]) => [key, [w.occurrences, w.total] as const] as const)
		);
	}

	/** What was added since `snapshot`, as counts of the difference, in first-seen order. */
	since(snapshot: WarningSnapshot): ScriptWarning[] {
		const added: ScriptWarning[] = [];
		for (const [key, w] of this.byKey) {
			const [occurrences, total] = snapshot.get(key) ?? [0, 0];
			if (w.occurrences > occurrences) {
				added.push({
					code: w.code,
					occurrences: w.occurrences - occurrences,
					total: w.total - total,
					detail: w.detail
				});
			}
		}
		return added;
	}
}
