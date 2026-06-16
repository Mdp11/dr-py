// Dev-time autoload: when `pixi run start-frontend <mm> <model> <view>` is used,
// the Vite dev server serves the metamodel/view files at `/__autoload/*` and
// exposes their basenames as `VITE_AUTOLOAD_*_NAME`. The MODEL is no longer
// fetched into the browser at all: `VITE_AUTOLOAD_MODEL_PATH` carries the
// resolved path and the backend loads it from disk via POST /model/load
// (backend and dev server share the filesystem — localhost trust model).

import { metamodel as metamodelApi } from '$lib/api';
import { loadModelFromPath } from '$lib/api/model-ops';
import { ViewSchema } from '$lib/api/types';
import {
	adoptSummary,
	clearChangesBadge,
	clearIssues,
	clearViewState,
	pushView,
	refreshChangesBadge,
	resetModelStore,
	setFileHandle,
	setFilename,
	setMetamodel,
	setMetamodelFilename,
	setViewBaseline,
	setViewFilename
} from '$lib/state';

let started = false;

export async function maybeAutoload(): Promise<void> {
	if (started) return;
	started = true;

	const mmName = import.meta.env.VITE_AUTOLOAD_METAMODEL_NAME as string | undefined;
	const modelName = import.meta.env.VITE_AUTOLOAD_MODEL_NAME as string | undefined;
	const modelPath = import.meta.env.VITE_AUTOLOAD_MODEL_PATH as string | undefined;
	const viewName = import.meta.env.VITE_AUTOLOAD_VIEW_NAME as string | undefined;
	if (!mmName) return;

	try {
		const mmText = await fetchText('/__autoload/metamodel');
		const mmBody = isYaml(mmName) ? mmText : JSON.parse(mmText);
		const mm = await metamodelApi.uploadMetamodel(mmBody);
		setMetamodel(mm);
		setMetamodelFilename(mmName);
		setViewFilename(null);
		// Drop any view carried over from a prior session; a fresh view (if the
		// autoload specifies one) is pushed and baselined below.
		clearViewState();
		resetModelStore();
		setFilename(null);
		setFileHandle(null);
		clearIssues();
		clearChangesBadge();

		if (!modelName || !modelPath) return;

		// Server-side path load: the model JSON never transits the browser.
		const summary = await loadModelFromPath(modelPath);
		resetModelStore();
		adoptSummary(summary);
		setFilename(modelName);
		setFileHandle(null);
		clearIssues();
		// best-effort, like every other badge refresh: a failure must not abort
		// the view autoload below
		refreshChangesBadge().catch((err) => {
			console.error('[autoload] changes badge refresh failed:', err);
		});

		if (!viewName) return;

		// The view snapshot requires an active model on the backend, which the
		// step above just established. Mirror the Load-view dialog: validate
		// against ViewSchema, then push.
		const viewText = await fetchText('/__autoload/view');
		const view = ViewSchema.parse(JSON.parse(viewText));
		// Baseline from the SERVER-echoed view so the view-change count starts at
		// 0 even if the backend normalizes the snapshot.
		const { view: storedView } = await pushView(view);
		setViewFilename(viewName);
		setViewBaseline(storedView);
	} catch (err) {
		console.error('[autoload] failed:', err);
	}
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: ${res.status} ${res.statusText}`);
	}
	return res.text();
}

function isYaml(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith('.yaml') || lower.endsWith('.yml');
}
