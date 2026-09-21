import { describe, expect, it } from 'vitest';
import type { ElementPage, ModelOp, WireElement } from '../../src/index.ts';
import { family, NODE_DOC } from '../model/fixtures.ts';
import { connect, fakeHost, openReplica, settle, smartCity, type Client } from './helpers.ts';

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

/** Resolves when the background digest check of the ready replica has ended. */
const verified = (client: Client) =>
	client.nextEvent((event) => event.task === 'verify' && event.done === event.total);

describe('arrival order', () => {
	it('answers reads posted before ready after it, in arrival order', async () => {
		const client = connect();
		const order: string[] = [];
		const a = client.call('getElement', { id: 'a' }).then(() => order.push('a'));
		const b = client.call('getElement', { id: 'b' }).then(() => order.push('b'));
		client.nextEvent((event) => event.state === 'ready').then(() => order.push('ready'));
		await settle();
		expect(order).toEqual([]);
		await openReplica(client, family(), NODE_DOC);
		await Promise.all([a, b]);
		expect(order).toEqual(['ready', 'a', 'b']);
	});

	it('lets a read posted after a stage see it', async () => {
		const client = connect();
		await openReplica(client, family(), NODE_DOC);
		const staging = client.call('stage', { ops: [rename('a', 'staged')] });
		const reading = client.call<WireElement>('getElement', { id: 'a' });
		await staging;
		expect((await reading).properties).toEqual({ name: 'staged' });
	});

	it('lands a stage posted during a re-bootstrap after the adopted batches', async () => {
		const client = connect();
		await openReplica(client, family(), NODE_DOC);
		await client.call('stage', { ops: [rename('a', 'first')] });
		const staged = await client.call<unknown[]>('staged');
		await client.call('close');
		const later = client.call<{ batch: { id: number } }>('stage', { ops: [rename('c', 'later')] });
		await openReplica(client, family(), NODE_DOC, { adopt: staged });
		expect((await later).batch.id).toBe(2);
		expect(await client.call('staged')).toEqual([
			{ id: 1, ops: [rename('a', 'first')] },
			{ id: 2, ops: [rename('c', 'later')] }
		]);
	});
});

describe('a transition waits for the scan before it', () => {
	async function scanning() {
		const host = fakeHost({ tick: 3 });
		host.auto = true;
		const client = connect(host);
		const { model, doc } = smartCity();
		const done = verified(client);
		await openReplica(client, model, doc);
		await done;
		await settle();
		host.auto = false;
		const order: string[] = [];
		const search = client
			.callAs<ElementPage>('search', 'listElementsPage', { q: 'organization', limit: 500 })
			.then((page) => {
				order.push('search');
				return page;
			});
		await settle();
		expect(host.waiting).toBe(1);
		return { host, client, order, search };
	}

	it('answers a read posted mid-scan first, and a stage and the read behind it after', async () => {
		const { host, client, order, search } = await scanning();
		const early = client.call('getElement', { id: 'e_000002' }).then(() => order.push('early'));
		const staging = client
			.call('stage', { ops: [rename('e_000001', 'renamed')] })
			.then(() => order.push('stage'));
		const late = client.call<WireElement>('getElement', { id: 'e_000001' }).then((element) => {
			order.push('late');
			return element;
		});
		host.auto = true;
		host.turn();
		const [page, , , element] = await Promise.all([search, early, staging, late]);
		expect(order).toEqual(['early', 'search', 'stage', 'late']);
		const hit = page.items.find((item) => item.id === 'e_000001');
		expect(hit?.properties['name']).toBe('Organization-001');
		expect(element.properties['name']).toBe('renamed');
	});

	it('answers nothing to a cancelled search, and serves the next request', async () => {
		const { host, client, search } = await scanning();
		let answered = false;
		void search.then(() => (answered = true));
		client.cancel('search');
		const next = client.call<WireElement>('getElement', { id: 'e_000001' });
		host.auto = true;
		host.turn();
		expect((await next).id).toBe('e_000001');
		await settle();
		expect(answered).toBe(false);
	});

	it('answers a scan cut short by close from the next replica', async () => {
		const { host, client, search } = await scanning();
		await client.call('close');
		host.auto = true;
		host.turn();
		await openReplica(client, family(), NODE_DOC);
		const page = await search;
		expect(page.total).toBe(0);
		const again = await client.call<ElementPage>('listElementsPage', { q: 'A' });
		expect(again.items.map((item) => item.id)).toEqual(['a']);
	});
});

describe('cancel', () => {
	it('stages nothing for a cancelled stage that was still queued', async () => {
		const client = connect();
		const staging = client.callAs('queued', 'stage', { ops: [rename('a', 'never')] });
		let answered = false;
		void staging.then(() => (answered = true));
		await settle();
		client.cancel('queued');
		await openReplica(client, family(), NODE_DOC);
		expect(await client.call('staged')).toEqual([]);
		expect(answered).toBe(false);
	});
});
