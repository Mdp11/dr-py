import { issueOwner, type Issue } from './issue.ts';

/** One owner's issues, and when the owner entered the store: store order is `seq` order. */
type Entry = { readonly issues: Issue[]; readonly seq: number };

const NO_ISSUES: readonly Issue[] = [];

function sameIssues(a: readonly Issue[], b: readonly Issue[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (
			x.severity !== y.severity ||
			x.category !== y.category ||
			x.check !== y.check ||
			x.message !== y.message ||
			x.targetIds.length !== y.targetIds.length ||
			x.targetIds.some((id, k) => id !== y.targetIds[k])
		) {
			return false;
		}
	}
	return true;
}

/**
 * The issues of one model by owner, as the Python core's `ValidationState`
 * keeps them: owners in insertion order, each owner's issues in the order
 * found. `replace` drops every dirty owner, then files the new issues, an
 * owner that comes back going last. The counts per severity are kept as the
 * store changes; their order is the order in which a walk of the store first
 * meets each severity, found from the earliest owner holding it.
 */
export class IssueStore {
	private readonly entries = new Map<string, Entry>();
	private readonly perSeverity = new Map<string, number>();
	/** Severity → the owners holding one of its issues, in store order. */
	private readonly holders = new Map<string, Set<string>>();
	private nextSeq = 0;
	private total = 0;

	get size(): number {
		return this.total;
	}

	/**
	 * Drops the issues of every `dirty` owner and files `issues`, the result of
	 * a scoped run over exactly those ids: an issue owned by an id outside
	 * `dirty` is refused before anything moves. True when some owner's issues
	 * now differ from its issues before, compared in order; an owner that only
	 * moved to the end does not count.
	 */
	replace(dirty: Iterable<string>, issues: readonly Issue[]): boolean {
		const owners = new Set(dirty);
		// Owners in order of first appearance, which is the order they re-enter in.
		const filed = new Map<string, Issue[]>();
		for (const issue of issues) {
			const owner = issueOwner(issue);
			if (!owners.has(owner)) {
				throw new Error(`issue owner ${JSON.stringify(owner)} is not in the dirty set`);
			}
			const list = filed.get(owner);
			if (list === undefined) filed.set(owner, [issue]);
			else list.push(issue);
		}
		const before = new Map<string, readonly Issue[]>();
		for (const owner of owners) {
			const entry = this.entries.get(owner);
			if (entry === undefined) continue;
			before.set(owner, entry.issues);
			this.drop(owner, entry);
		}
		for (const [owner, list] of filed) this.file(owner, list);
		for (const owner of owners) {
			if (!sameIssues(before.get(owner) ?? NO_ISSUES, this.issuesOf(owner))) return true;
		}
		return false;
	}

	*iter(): IterableIterator<Issue> {
		for (const entry of this.entries.values()) yield* entry.issues;
	}

	/** The owners holding issues, in store order. */
	owners(): IterableIterator<string> {
		return this.entries.keys();
	}

	issuesOf(owner: string): readonly Issue[] {
		return this.entries.get(owner)?.issues ?? NO_ISSUES;
	}

	/** Issues per severity, in the order a walk of the store meets them first; `{}` when empty. */
	counts(): { [severity: string]: number } {
		const firsts: { severity: string; seq: number; at: number }[] = [];
		for (const [severity, owners] of this.holders) {
			const owner = owners.values().next().value!;
			const entry = this.entries.get(owner)!;
			const at = entry.issues.findIndex((issue) => issue.severity === severity);
			firsts.push({ severity, seq: entry.seq, at });
		}
		firsts.sort((a, b) => a.seq - b.seq || a.at - b.at);
		const out: { [severity: string]: number } = {};
		for (const { severity } of firsts) out[severity] = this.perSeverity.get(severity)!;
		return out;
	}

	private drop(owner: string, entry: Entry): void {
		this.entries.delete(owner);
		this.total -= entry.issues.length;
		for (const issue of entry.issues) {
			const severity = issue.severity;
			const n = this.perSeverity.get(severity)! - 1;
			if (n > 0) {
				this.perSeverity.set(severity, n);
				this.holders.get(severity)!.delete(owner);
			} else {
				this.perSeverity.delete(severity);
				this.holders.delete(severity);
			}
		}
	}

	/** Files an owner that is not in the store, last: every holder set stays in store order. */
	private file(owner: string, issues: Issue[]): void {
		this.entries.set(owner, { issues, seq: this.nextSeq++ });
		this.total += issues.length;
		for (const { severity } of issues) {
			this.perSeverity.set(severity, (this.perSeverity.get(severity) ?? 0) + 1);
			let owners = this.holders.get(severity);
			if (owners === undefined) this.holders.set(severity, (owners = new Set()));
			owners.add(owner);
		}
	}
}
