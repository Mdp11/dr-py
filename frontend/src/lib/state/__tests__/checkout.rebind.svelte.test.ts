import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import * as mmApi from '$lib/api/metamodel';
import { listContainmentRoots } from '$lib/api/model-read';
import type { Metamodel } from '$lib/api/types';
import * as validationApi from '$lib/api/validation';
import { createSnapshotCache } from '$lib/engine/cache';
import type { EngineLink } from '$lib/engine/client';
import { replicaApi, type ReplicaStatus } from '$lib/engine/sync';
import { connectInProcess } from '$lib/engine/testing';
import { BASE, fakeProject } from '$lib/engine/__tests__/support/project-server';
import { clearActiveProject, setActiveProject } from '../active-project.svelte';
import {
	commitStaged,
	resetCheckout,
	setCheckoutApiConfig,
	setProjectInfo
} from '../checkout.svelte';
import { clearMetamodel } from '../metamodel.svelte';
import { emit, getModelSummary, getStructureRev, resetModelStore } from '../model.svelte';
import { configureReplica, resetReplica, startReplica } from '../replica.svelte';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const links: EngineLink[] = [];

beforeEach(() => {
	resetModelStore();
	resetCheckout();
	clearMetamodel();
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
});

afterEach(() => {
	setCheckoutApiConfig(undefined);
	resetReplica();
	for (const link of links.splice(0)) link.dispose();
	clearActiveProject();
	resetCheckout();
	server.resetHandlers();
	vi.restoreAllMocks();
});

describe('an own commit that rebinds the metamodel', () => {
	it('re-reads the structure once the replica has followed the new metamodel', async () => {
		const project = fakeProject();
		const watchers: { test: (s: ReplicaStatus) => boolean; resolve(): void }[] = [];
		const until = (test: (s: ReplicaStatus) => boolean) =>
			new Promise<void>((resolve) => watchers.push({ test, resolve }));
		configureReplica({
			deps: {
				connect: () => {
					const link = connectInProcess();
					links.push(link);
					return Promise.resolve(link);
				},
				api: replicaApi(BASE),
				cache: createSnapshotCache({ factory: new IDBFactory() }),
				sleep: () => Promise.resolve(),
				onStatus: (status) => {
					for (const watcher of [...watchers]) {
						if (watcher.test(status)) {
							watchers.splice(watchers.indexOf(watcher), 1);
							watcher.resolve();
						}
					}
				}
			}
		});
		server.use(...project.handlers());
		const ready = until((s) => s.phase === 'ready');
		setActiveProject('p');
		startReplica();
		await ready;
		const before = (await listContainmentRoots()).total;

		// The server lands a new root and swaps the metamodel in the same commit.
		const landed = project.commit([
			{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Organization', properties: {} }
		]);
		project.rebind('mm-2');
		const response = {
			...(JSON.parse(landed.responseText) as Record<string, unknown>),
			model_rev: project.rev,
			prev_rev: project.rev - 1,
			id_map: { tmp_1: 'srv-1' },
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {},
			commit_id: 'c-2',
			message: 'm',
			validation_error_count: 0,
			changed_artifacts: [],
			deleted_artifact_ids: [],
			rebound: true,
			to_metamodel_id: 'mm-2'
		};
		server.use(http.post(`${project.baseUrl}/commits`, () => HttpResponse.json(response)));
		setCheckoutApiConfig({ baseUrl: project.baseUrl });
		vi.spyOn(mmApi, 'getMetamodel').mockResolvedValue({
			elements: [],
			relationships: []
		} as unknown as Metamodel);
		vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
			model_rev: project.rev,
			issues: [],
			counts: {},
			truncated: false,
			rules_status: null
		});

		// The tree: every structure rev re-reads the roots; the last read started is what shows.
		const reads: Promise<number>[] = [];
		const cleanup = $effect.root(() => {
			$effect(() => {
				void getStructureRev();
				reads.push(listContainmentRoots().then((page) => page.total));
			});
		});
		try {
			emit({
				kind: 'create_element',
				temp_id: 'tmp_1',
				type_name: 'Organization',
				properties: {}
			});
			const followed = until((s) => s.phase === 'ready' && s.rev === project.rev);
			await commitStaged('m', false);
			await followed;

			await vi.waitFor(async () => expect(await reads[reads.length - 1]).toBe(before + 1));
			// The adoption ends with the summary, read from the replica too.
			await vi.waitFor(() => expect(getModelSummary()?.model_rev).toBe(project.rev));
		} finally {
			cleanup();
		}
	});
});
