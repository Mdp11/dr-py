import type { EvalContext } from '../evaluate/index.ts';
import type { Model } from '../model/model.ts';
import { ReadError } from '../read/errors.ts';
import type { ReadParams } from '../read/params.ts';
import type { Steps } from '../steps/steps.ts';
import { wireIssue, type Issue, type IssueOut } from '../validation/issue.ts';
import { pyRepr } from '../value/repr.ts';

export type ArtifactRefDoc = { id: string; kind: string };

export type FolderDoc = {
	id: string;
	name: string;
	folders: FolderDoc[];
	elements: string[];
	artifacts: ArtifactRefDoc[];
};

export type ViewDoc = { name: string; folders: FolderDoc[]; artifacts: ArtifactRefDoc[] };

type Doc = { [key: string]: unknown };

function refuse(path: string, what: string): never {
	throw new ReadError(422, `${path}: ${what}`);
}

function readObject(value: unknown, path: string): Doc {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		refuse(path, 'must be an object');
	}
	return value as Doc;
}

function readString(doc: Doc, key: string, path: string, fallback?: string): string {
	const value = doc[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== 'string') refuse(`${path}.${key}`, 'must be a string');
	return value;
}

/** A list under `key`, `[]` when absent, each item read by `item`. */
function readList<T>(
	doc: Doc,
	key: string,
	path: string,
	item: (value: unknown, path: string) => T
): T[] {
	const value = doc[key];
	if (value === undefined) return [];
	if (!Array.isArray(value)) refuse(`${path}.${key}`, 'must be a list');
	return value.map((entry, i) => item(entry, `${path}.${key}[${i}]`));
}

function readRef(value: unknown, path: string): ArtifactRefDoc {
	const doc = readObject(value, path);
	return { id: readString(doc, 'id', path), kind: readString(doc, 'kind', path) };
}

function readFolder(value: unknown, path: string): FolderDoc {
	const doc = readObject(value, path);
	return {
		id: readString(doc, 'id', path, ''),
		name: readString(doc, 'name', path),
		folders: readList(doc, 'folders', path, readFolder),
		elements: readList(doc, 'elements', path, (v, p) => {
			if (typeof v !== 'string') refuse(p, 'must be a string');
			return v;
		}),
		artifacts: readList(doc, 'artifacts', path, readRef)
	};
}

/**
 * A view document as `View.model_validate` reads it: `name` required, an
 * absent `folders`, `elements` or `artifacts` `[]`, a folder's `id` `''`,
 * unknown keys ignored. A field of another type is a 422 `view: …`.
 */
export function readViewDoc(value: unknown): ViewDoc {
	const doc = readObject(value, 'view');
	return {
		name: readString(doc, 'name', 'view'),
		folders: readList(doc, 'folders', 'view', readFolder),
		artifacts: readList(doc, 'artifacts', 'view', readRef)
	};
}

const warning = (message: string, targetIds: string[] = []): Issue => ({
	severity: 'warning',
	message,
	targetIds,
	category: 'conformance',
	check: 'view'
});

/** One folder being walked: its path, the sibling names seen so far, the next child to visit. */
type Frame = { folder: FolderDoc; path: string; seen: Set<string>; next: number };

/**
 * `validate_view`: the warnings of `view` over `model`, in the order the
 * recursive walk gives them, from an explicit stack so a deep chain of
 * folders costs no call stack. `known` says whether an artifact id resolves.
 */
export function validateViewDoc(
	view: ViewDoc,
	model: Model,
	known: (id: string) => boolean
): Issue[] {
	const issues: Issue[] = [];
	const placed = new Map<string, string>();
	const viewName = pyRepr(view.name);

	const checkArtifacts = (refs: ArtifactRefDoc[], where: string): void => {
		for (const ref of refs) {
			if (known(ref.id)) continue;
			issues.push(
				warning(
					`view ${viewName}: ${where} references unknown artifact ${pyRepr(ref.id)}; renderers skip it`
				)
			);
		}
	};

	const checkElements = (folder: FolderDoc, path: string): void => {
		for (const id of folder.elements) {
			const element = model.findElement(id);
			if (element === undefined) {
				issues.push(
					warning(
						`view ${viewName}: folder ${pyRepr(path)} references unknown element ${pyRepr(id)}`,
						[id]
					)
				);
				continue;
			}
			if (element.parents.length > 0) {
				issues.push(
					warning(
						`view ${viewName}: element ${pyRepr(id)} has a containment parent and cannot be placed in folder ${pyRepr(path)}; placement ignored`,
						[id]
					)
				);
				continue;
			}
			const existing = placed.get(id);
			if (existing !== undefined) {
				issues.push(
					warning(
						`view ${viewName}: element ${pyRepr(id)} is placed in multiple folders (${pyRepr(existing)} and ${pyRepr(path)}); first placement wins`,
						[id]
					)
				);
				continue;
			}
			placed.set(id, path);
		}
	};

	const enter = (folder: FolderDoc, path: string, stack: Frame[]): void => {
		checkArtifacts(folder.artifacts, `folder ${pyRepr(path)}`);
		stack.push({ folder, path, seen: new Set(), next: 0 });
	};

	const topSeen = new Set<string>();
	for (const top of view.folders) {
		if (topSeen.has(top.name)) {
			issues.push(
				warning(
					`view ${viewName}: duplicate top-level folder ${pyRepr(top.name)}; later occurrence ignored`
				)
			);
			continue;
		}
		topSeen.add(top.name);
		const stack: Frame[] = [];
		enter(top, top.name, stack);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const { folder, path, seen } = frame;
			if (frame.next === folder.folders.length) {
				checkElements(folder, path);
				stack.pop();
				continue;
			}
			const child = folder.folders[frame.next++]!;
			if (seen.has(child.name)) {
				const where = path === '' ? "'/'" : pyRepr(path);
				issues.push(
					warning(
						`view ${viewName}: duplicate folder ${pyRepr(child.name)} under ${where}; later occurrence ignored`
					)
				);
				continue;
			}
			seen.add(child.name);
			enter(child, `${path}/${child.name}`, stack);
		}
	}

	checkArtifacts(view.artifacts, 'the view root');
	return issues;
}

/**
 * `validateView {view}`: the view's warnings over the working model and the
 * working artifacts, as the route sends them. The view is read before the
 * first step, so a refusal leaves nothing behind.
 */
export function validateView(ctx: EvalContext, params: ReadParams): Steps<IssueOut[]> {
	const view = readViewDoc(params['view']);
	const { model, artifacts } = ctx;
	return (function* (): Steps<IssueOut[]> {
		const issues = validateViewDoc(view, model, (id) => artifacts.resolve(id) !== null);
		yield { done: 1, total: 1 };
		return issues.map((i) => wireIssue(i, 'on_server'));
	})();
}
