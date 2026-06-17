import type { ViewChange } from './view-diff';

const joinPath = (path: string[]): string => (path.length === 0 ? '(root)' : path.join('/'));

/**
 * A piece of a formatted view-change line, tagged with the role it plays so the
 * UI can colour each component (element name, folder, the from/to prepositions)
 * distinctly. `plain` is the connective text (verbs, "Folder", punctuation).
 */
export type ViewChangeSegmentKind = 'element' | 'folder' | 'prep' | 'plain';
export interface ViewChangeSegment {
	text: string;
	kind: ViewChangeSegmentKind;
}

const el = (text: string): ViewChangeSegment => ({ text, kind: 'element' });
const folder = (path: string[]): ViewChangeSegment => ({
	text: `'${joinPath(path)}'`,
	kind: 'folder'
});
const prep = (text: string): ViewChangeSegment => ({ text, kind: 'prep' });
const plain = (text: string): ViewChangeSegment => ({ text, kind: 'plain' });

/**
 * Structured form of {@link formatViewChange}: the same one-line description
 * split into typed segments so each component can be highlighted. Concatenating
 * the segment texts reproduces `formatViewChange` exactly.
 */
export function viewChangeSegments(
	change: ViewChange,
	resolveName: (id: string) => string
): ViewChangeSegment[] {
	switch (change.kind) {
		case 'element-moved':
			return [
				el(resolveName(change.id)),
				plain(' moved '),
				prep('from'),
				plain(' '),
				folder(change.from),
				plain(' '),
				prep('to'),
				plain(' '),
				folder(change.to)
			];
		case 'element-removed':
			return [el(resolveName(change.id)), plain(' removed from view')];
		case 'element-added':
			return [
				el(resolveName(change.id)),
				plain(' added '),
				prep('to'),
				plain(' '),
				folder(change.to)
			];
		case 'folder-added':
			return [plain('Folder '), folder(change.path), plain(' created')];
		case 'folder-removed':
			return [plain('Folder '), folder(change.path), plain(' deleted')];
	}
}

/**
 * Human-readable one-line description of a single view change. `resolveName`
 * maps an element id to its display name (falling back to the id itself).
 */
export function formatViewChange(change: ViewChange, resolveName: (id: string) => string): string {
	return viewChangeSegments(change, resolveName)
		.map((s) => s.text)
		.join('');
}
