// The `issues` surface over the real engine: a replica of a fake project,
// swept, behind a seam whose issues gate is the replica's `seeded`.
import { http, HttpResponse } from 'msw';
import type { MetamodelDoc, StageResult } from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import { SURFACE_DEFAULTS } from '$lib/engine/surfaces';
import type { ReplicaStatus } from '$lib/engine/sync';
import type { ModelOp } from '$lib/state/ops';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { setActiveBaseUrl } from '../client';
import { installEngineSeam, type EngineSeam, type Side, type Surface } from '../engine-route';
import { server } from './server';

export type IssuesEngine = Awaited<ReturnType<typeof issuesEngine>>;

/** `name` is `max_length` 200 in the smart-city metamodel. */
export const TOO_LONG = 'x'.repeat(201);
export const TOO_LONG_MESSAGE = 'name: length 201 exceeds max_length 200';
/** Another name as long, so two elements named so are no duplicates. */
export const ALSO_TOO_LONG = 'y'.repeat(201);

export const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

/** Commits renames on `project`, as a peer would. */
export function commitNames(project: FakeProject, names: { [id: string]: string }): void {
	project.commit(
		Object.entries(names).map(([id, name]) => ({
			kind: 'update_element' as const,
			id,
			properties_patch: { name }
		}))
	);
}

/** The smart-city metamodel with `name` under a pattern the regex translator refuses. */
export function unsupportedPatternDoc(doc: MetamodelDoc): MetamodelDoc {
	const copy = JSON.parse(JSON.stringify(doc)) as {
		elements: { name: string; properties: { name: string; pattern: string | null }[] }[];
	};
	const named = copy.elements.find((element) => element.name === 'NamedElement')!;
	named.properties.find((property) => property.name === 'name')!.pattern = '(?x)a';
	return copy as unknown as MetamodelDoc;
}

/** The smart-city metamodel with `name` allowed 300 characters, so `TOO_LONG` passes under it. */
export function longerNamesDoc(doc: MetamodelDoc): MetamodelDoc {
	const copy = JSON.parse(JSON.stringify(doc)) as {
		elements: { name: string; properties: { name: string; max_length: number | null }[] }[];
	};
	const named = copy.elements.find((element) => element.name === 'NamedElement')!;
	named.properties.find((property) => property.name === 'name')!.max_length = 300;
	return copy as unknown as MetamodelDoc;
}

/** A structural diff as `/metamodel/structural-diff` answers one. */
export const STRUCTURAL = {
	enums: { added: [], removed: [], changed: [] },
	element_types: {
		added: [],
		removed: [],
		changed: [
			{
				name: 'NamedElement',
				attributes: [],
				properties: {
					added: [],
					removed: [],
					changed: [{ name: 'name', fields: [{ field: 'max_length', from: 200, to: 300 }] }]
				}
			}
		]
	},
	relationship_types: { added: [], removed: [], changed: [] }
};

/** What `/metamodel/diff` answers: every issue passing, the structural diff as `STRUCTURAL`. */
export const SERVER_DIFF = {
	now_failing: [],
	now_passing: [],
	unchanged_count: 0,
	current_error_count: 0,
	candidate_error_count: 0,
	structural: STRUCTURAL
};

/**
 * A ready, swept replica of `project` behind an installed seam with the
 * issues on the engine and every other surface as it defaults, or as
 * `surfaces` sets it; the active base URL is the project's, so the server
 * side of a call reaches MSW. `requests` records the server's issue routes
 * and the candidate routes (`lint`, `structural-diff`, `diff`, their body
 * the text sent); lint answers `lint(text)`, by default ok with
 * `longerNamesDoc` as its document. `seeded`, when given, stands for the
 * replica's own flag in the seam, and the replica is awaited `ready` rather
 * than swept; `shadow` is the seam's.
 */
export async function issuesEngine(
	made: { dispose(): void }[],
	options: {
		project?: FakeProject;
		seeded?: () => boolean;
		shadow?: EngineSeam['shadow'];
		surfaces?: Partial<Record<Surface, Side>>;
		lint?: (text: string) => Record<string, unknown>;
	} = {}
) {
	const project = options.project ?? fakeProject();
	server.use(...project.handlers());
	const over = syncOver(project);
	made.push(over);
	over.sync.open(project.projectId);
	await (options.seeded === undefined
		? over.until((status) => status.seeded)
		: over.until((status) => status.phase === 'ready'));
	const requests: { route: string; body: unknown }[] = [];
	const record =
		(route: string) =>
		async ({ request }: { request: Request }) => {
			const text = request.method === 'GET' ? '' : await request.text();
			requests.push({ route, body: text === '' ? null : (JSON.parse(text) as unknown) });
			return null;
		};
	const base = project.baseUrl;
	const lint =
		options.lint ?? (() => ({ ok: true, errors: [], document: longerNamesDoc(project.doc) }));
	server.use(
		http.get(`${base}/model/issues`, async (info) => {
			await record('issues')(info);
			return HttpResponse.json({ model_rev: project.rev, issues: [], counts: {} });
		}),
		http.post(`${base}/model/validate`, async (info) => {
			await record('validate')(info);
			return HttpResponse.json([]);
		}),
		http.post(`${base}/commits/preview`, async (info) => {
			await record('preview')(info);
			return HttpResponse.json({
				conformance_error_count: 0,
				structural_blockers: [],
				issues: [],
				would_block: false
			});
		}),
		http.post(`${base}/metamodel/lint`, async ({ request }) => {
			const text = await request.text();
			requests.push({ route: 'lint', body: text });
			return HttpResponse.json(lint(text));
		}),
		http.post(`${base}/metamodel/structural-diff`, async ({ request }) => {
			requests.push({ route: 'structural-diff', body: await request.text() });
			return HttpResponse.json(STRUCTURAL);
		}),
		http.post(`${base}/metamodel/diff`, async ({ request }) => {
			requests.push({ route: 'diff', body: await request.text() });
			return HttpResponse.json(SERVER_DIFF);
		})
	);
	setActiveBaseUrl(base);
	const seeded = options.seeded ?? (() => over.sync.status().seeded);
	const surfaces: Record<Surface, Side> = {
		...SURFACE_DEFAULTS,
		issues: 'engine',
		...options.surfaces
	};
	const sync = {
		status: (): ReplicaStatus => ({ ...over.sync.status(), seeded: seeded() }),
		call: over.sync.call.bind(over.sync)
	};
	installEngineSeam(
		createEngineSeam(sync, surfaces, options.shadow, {
			issues: () => seeded(),
			metamodel: () => seeded()
		})
	);
	return {
		project,
		over,
		requests,
		/** Stages `ops` as one batch in the replica; resolves with its batch id. */
		stage: async (ops: ModelOp[]): Promise<number> =>
			(await over.link!.client.call<StageResult>('stage', { ops })).batch.id
	};
}

/** Undoes what `issuesEngine` installed; the caller disposes what it made. */
export function uninstallIssuesEngine(): void {
	installEngineSeam(null);
	setActiveBaseUrl(null);
}
