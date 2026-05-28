// Dev-time autoload: when `pixi run start-frontend <mm> <model>` is used, the
// Vite dev server serves the two files at `/__autoload/metamodel` and
// `/__autoload/model` and exposes their basenames as `VITE_AUTOLOAD_*` so we
// can detect the request and replay the dialog upload paths.

import { metamodel as metamodelApi, model as modelApi } from '$lib/api';
import {
	clearIssues,
	resetOps,
	setBaseline,
	setFileHandle,
	setFilename,
	setMetamodel
} from '$lib/state';

let started = false;

export async function maybeAutoload(): Promise<void> {
	if (started) return;
	started = true;

	const mmName = import.meta.env.VITE_AUTOLOAD_METAMODEL_NAME as string | undefined;
	const modelName = import.meta.env.VITE_AUTOLOAD_MODEL_NAME as string | undefined;
	if (!mmName) return;

	try {
		const mmText = await fetchText('/__autoload/metamodel');
		const mmBody = isYaml(mmName) ? mmText : JSON.parse(mmText);
		const mm = await metamodelApi.uploadMetamodel(mmBody);
		setMetamodel(mm);
		setBaseline(null);
		setFilename(null);
		setFileHandle(null);
		resetOps();
		clearIssues();

		if (!modelName) return;

		const modelText = await fetchText('/__autoload/model');
		const parsed = JSON.parse(modelText) as {
			elements?: unknown[];
			relationships?: unknown[];
		};
		const loaded = await modelApi.uploadModel({
			elements: (parsed.elements ?? []) as never,
			relationships: (parsed.relationships ?? []) as never
		});
		setBaseline(loaded);
		setFilename(modelName);
		setFileHandle(null);
		resetOps();
		clearIssues();
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
