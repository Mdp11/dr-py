/**
 * PERSONAL preferences for the metamodel form panel:
 * whether the whole 320px column is collapsed, and which TOC sections are
 * folded. Per-project, in localStorage, mirroring the view/collapse
 * preferences in `metamodel-diagram.svelte.ts` — same try/catch stance
 * (storage denial just means the preference doesn't persist), same
 * init/close lifecycle driven by `MetamodelTab`.
 *
 * `setMetamodelPanelCollapsed(false)` is also the "reopen on reveal" hook:
 * `revealSelection` calls it because navigating via search or the TOC
 * implies wanting the form, while a plain canvas click deliberately does NOT
 * reopen a collapsed panel.
 */

export type PanelSectionKey = 'elements' | 'relationships' | 'enums';

export interface MetamodelPanelState {
	collapsed: boolean;
	/** true = section folded. */
	sections: Readonly<Record<PanelSectionKey, boolean>>;
}

const DEFAULT_SECTIONS: Record<PanelSectionKey, boolean> = {
	elements: false,
	relationships: false,
	enums: false
};

let _projectId: string | null = null;
let _collapsed = $state(false);
let _sections = $state<Record<PanelSectionKey, boolean>>({ ...DEFAULT_SECTIONS });

function panelKey(projectId: string): string {
	return `ui.metamodel.panelCollapsed.${projectId}`;
}

function sectionsKey(projectId: string): string {
	return `ui.metamodel.panelSections.${projectId}`;
}

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage full/denied: the preference simply doesn't persist */
	}
}

export function getMetamodelPanel(): MetamodelPanelState {
	return { collapsed: _collapsed, sections: _sections };
}

export function setMetamodelPanelCollapsed(v: boolean): void {
	_collapsed = v;
	if (_projectId !== null) writeStored(panelKey(_projectId), v ? '1' : '0');
}

export function toggleMetamodelPanelSection(key: PanelSectionKey): void {
	_sections = { ..._sections, [key]: !_sections[key] };
	if (_projectId !== null) {
		const folded = (Object.keys(_sections) as PanelSectionKey[]).filter((k) => _sections[k]);
		writeStored(sectionsKey(_projectId), JSON.stringify(folded));
	}
}

export function initMetamodelPanel(projectId: string): void {
	_projectId = projectId;
	_collapsed = readStored(panelKey(projectId)) === '1';
	const next = { ...DEFAULT_SECTIONS };
	const raw = readStored(sectionsKey(projectId));
	if (raw !== null) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				for (const k of parsed)
					if (typeof k === 'string' && k in next) next[k as PanelSectionKey] = true;
			}
		} catch {
			/* corrupt entry: everything simply opens expanded */
		}
	}
	_sections = next;
}

export function closeMetamodelPanel(): void {
	_projectId = null;
	_collapsed = false;
	_sections = { ...DEFAULT_SECTIONS };
}
