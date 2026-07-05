// Shared drag controller: holds the active drag payload + lifecycle so a drag
// can be STARTED from one component (e.g. Search) and COMPLETED by another
// (the tree's pointer/drop machinery). Geometry/hit-testing stays in the tree.
//
// This is module-global singleton state: it assumes a single active containment
// tree (one sidebar). Two concurrently-mounted trees would both adopt the same
// drag — not a supported layout.

export type DragPayload =
	| { kind: 'element'; ids: string[] }
	| { kind: 'folder'; path: string[] }
	| { kind: 'artifact'; id: string; artifactKind: string };

let _payload = $state<DragPayload | null>(null);
let _active = $state(false);
// When a drag originates from search, the dragged element is not part of the
// tree's movable set; this flag tells the tree to validate it by "is it known"
// rather than "is it movable".
let _bypassMovable = $state(false);

export function getDragPayload(): DragPayload | null {
	return _payload;
}
export function isDragActive(): boolean {
	return _active;
}
export function isMovableBypassed(): boolean {
	return _bypassMovable;
}
export function beginDrag(payload: DragPayload, bypassMovable = false): void {
	_payload = payload;
	_active = true;
	_bypassMovable = bypassMovable;
}
export function endDrag(): void {
	_payload = null;
	_active = false;
	_bypassMovable = false;
}
