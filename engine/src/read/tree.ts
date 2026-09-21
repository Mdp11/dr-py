import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import type { ElementRec } from '../model/records.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { idOf, idsOf, optionalString, pageOf, type ReadParams } from './params.ts';
import type { ViewPlacements } from './placements.ts';

/** A tree row: what the tree renders, without the property bag. */
export type TreeItem = { id: string; type_name: string; display_name: string; child_count: number };

export type TreeItemPage = { items: TreeItem[]; total: number };

/**
 * The distinct elements whose FIRST containment parent is `element`, in no
 * particular order: a child held by several parents belongs to the first.
 */
function childrenOf(model: Model, element: ElementRec): ElementRec[] {
	const children = new Set<ElementRec>();
	for (const rel of element.out) {
		if (!model.metamodel.isContainment(rel.typeName)) continue;
		if (rel.target.parents[0]?.source === element) children.add(rel.target);
	}
	return [...children];
}

export function treeItem(model: Model, element: ElementRec): TreeItem {
	return {
		id: element.id,
		type_name: element.typeName,
		display_name: displayName(element),
		child_count: childrenOf(model, element).length
	};
}

/** `POST /model/elements/tree-items`: request order, duplicates kept, unknown ids left out. */
export function getTreeItemsBatch(
	model: Model,
	_: ViewPlacements,
	params: ReadParams
): { items: TreeItem[] } {
	const items: TreeItem[] = [];
	for (const id of idsOf(params)) {
		const element = model.findElement(id);
		if (element !== undefined) items.push(treeItem(model, element));
	}
	return { items };
}

/** `GET /model/containment/roots`, off the maintained root order. */
export function listContainmentRoots(
	model: Model,
	_: ViewPlacements,
	params: ReadParams
): TreeItemPage {
	const { limit, offset } = pageOf(params);
	const roots = model.indexes.roots.list();
	return {
		items: roots.slice(offset, offset + limit).map((root) => treeItem(model, root)),
		total: roots.length
	};
}

/** `GET /model/containment/roots/excluded`: the roots a view does not place, `total` over all of them. */
export function listExcludedRoots(
	model: Model,
	placements: ViewPlacements,
	params: ReadParams
): TreeItemPage {
	const { limit, offset } = pageOf(params);
	const placed = placements.placed(optionalString(params, 'view_id'));
	const items: TreeItem[] = [];
	let total = 0;
	for (const root of model.indexes.roots.list()) {
		if (placed.has(root.id)) continue;
		if (total >= offset && items.length < limit) items.push(treeItem(model, root));
		total++;
	}
	return { items, total };
}

/** `GET /model/elements/{id}/children`, sorted by display name, then id, both by code point. */
export function listContainmentChildren(
	model: Model,
	_: ViewPlacements,
	params: ReadParams
): TreeItemPage {
	const { limit, offset } = pageOf(params);
	const element = model.getElement(idOf(params));
	const children = childrenOf(model, element)
		.map((child) => ({ child, name: displayName(child) }))
		.sort((a, b) => cmpCodePoint(a.name, b.name) || cmpCodePoint(a.child.id, b.child.id));
	return {
		items: children.slice(offset, offset + limit).map(({ child }) => treeItem(model, child)),
		total: children.length
	};
}
