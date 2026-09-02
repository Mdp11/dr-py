import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	editLock,
	connectLock,
	deleteLock,
	acquireArtifactLease,
	artifactDeleteLock,
	artifactEditLock,
	folderCreateLock,
	folderDeleteLock,
	folderEditLock,
	folderTargets,
	lockHolderLabel
} from '../edit-gate';
import { setProjectInfo, resetCheckout } from '../index';
import { getLockNotice, setLockNotice } from '../lock-notice.svelte';
import * as api from '$lib/api/checkout';
import { setActiveViewId } from '../active-view.svelte';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	setLockNotice(null);
});

describe('edit-gate', () => {
	it('editLock acquires exclusive edit and returns true', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't',
			leases: [
				{
					resource_id: 'e1',
					mode: 'exclusive',
					holder: 'default-user',
					holder_email: 'me@x.io',
					token: 't',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		expect(await editLock('e1')).toBe(true);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'e1', mode: 'exclusive' }],
			intent: 'edit'
		});
	});

	it('connectLock requests exclusive source + shared target with connect intent', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		await connectLock('s', 't');
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [
				{ resource_id: 's', mode: 'exclusive' },
				{ resource_id: 't', mode: 'shared' }
			],
			intent: 'connect'
		});
	});

	it('deleteLock requests exclusive delete', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		await deleteLock('e9');
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'e9', mode: 'exclusive' }],
			intent: 'delete'
		});
	});

	it('returns false and posts a notice on conflict', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{ conflicts: [{ resource_id: 'e1', held_by: 'bob', held_mode: 'exclusive' }] },
				'lock conflict'
			)
		);
		expect(await editLock('e1')).toBe(false);
	});

	it('names the conflict holder by email in the notice when available', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{
					conflicts: [
						{
							resource_id: 'e1',
							held_by: 'bob-uuid',
							held_by_email: 'bob@x.io',
							held_mode: 'exclusive'
						}
					]
				},
				'lock conflict'
			)
		);
		expect(await editLock('e1')).toBe(false);
		expect(getLockNotice()).toBe('Locked by bob@x.io.');
	});
});

describe('artifact edit gate', () => {
	it('acquireArtifactLease sends the bare id with type artifact', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't',
			leases: [
				{
					resource_id: 'art:a1',
					mode: 'exclusive',
					holder: 'default-user',
					token: 't',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		expect(await acquireArtifactLease('a1')).toEqual({ ok: true });
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
	});

	it('acquireArtifactLease returns the conflict so the editor can render the holder', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{
					conflicts: [
						{
							resource_id: 'art:a1',
							held_by: 'bob-uuid',
							held_by_email: 'bob@x.io',
							held_mode: 'exclusive'
						}
					]
				},
				'lock conflict'
			)
		);
		const res = await acquireArtifactLease('a1');
		expect(res.ok).toBe(false);
		// no global notice: the editor surfaces the holder inline
		expect(getLockNotice()).toBe(null);
		expect(lockHolderLabel(res as Extract<typeof res, { ok: false }>)).toBe('bob@x.io');
	});

	it('artifactDeleteLock uses delete intent and sets the lock notice on conflict', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		const spy = vi
			.spyOn(api, 'acquireLocks')
			.mockRejectedValue(
				new ConflictError(
					409,
					{ conflicts: [{ resource_id: 'art:a1', held_by: 'bob', held_mode: 'shared' }] },
					'lock conflict'
				)
			);
		expect(await artifactDeleteLock('a1')).toBe(false);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'delete'
		});
		expect(getLockNotice()).toBe('Locked by bob.');
	});

	it('artifactEditLock uses edit intent and sets the lock notice on conflict', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		const spy = vi
			.spyOn(api, 'acquireLocks')
			.mockRejectedValue(
				new ConflictError(
					409,
					{ conflicts: [{ resource_id: 'art:a1', held_by: 'bob', held_mode: 'exclusive' }] },
					'lock conflict'
				)
			);
		expect(await artifactEditLock('a1')).toBe(false);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		// Same channel as artifactDeleteLock: the sidebar's two write surfaces
		// must not report refusals differently.
		expect(getLockNotice()).toBe('Locked by bob.');
	});

	it('artifactEditLock clears the notice on success', async () => {
		setLockNotice('stale notice');
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		expect(await artifactEditLock('a1')).toBe(true);
		expect(getLockNotice()).toBe(null);
	});

	it('artifactDeleteLock clears the notice on success', async () => {
		setLockNotice('stale notice');
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		expect(await artifactDeleteLock('a1')).toBe(true);
		expect(getLockNotice()).toBe(null);
	});

	it('lockHolderLabel falls back when the 409 carried no conflict detail', () => {
		expect(lockHolderLabel({ ok: false, reason: 'conflict' })).toBe('someone else');
		expect(
			lockHolderLabel({
				ok: false,
				reason: 'conflict',
				conflicts: [{ resource_id: 'art:a1', held_by: 'bob-uuid', held_mode: 'exclusive' }]
			})
		).toBe('bob-uuid');
	});
});

describe('folderTargets', () => {
	it('sends exclusive type:folder targets, deduped', () => {
		expect(folderTargets(['f1', 'f2', 'f1'])).toEqual([
			{ resource_id: 'f1', mode: 'exclusive', type: 'folder' },
			{ resource_id: 'f2', mode: 'exclusive', type: 'folder' }
		]);
	});

	// The root is the one folder every view has, so its lease is the ACTIVE
	// view's own `view:` lease rather than a shared `folder:root`.
	it("maps the root to the active view's type:view target", () => {
		setActiveViewId('v1');
		try {
			expect(folderTargets(['root', 'f1'])).toEqual([
				{ resource_id: 'v1', mode: 'exclusive', type: 'view' },
				{ resource_id: 'f1', mode: 'exclusive', type: 'folder' }
			]);
		} finally {
			setActiveViewId(null);
		}
	});

	it('refuses a root target with no active view', () => {
		setActiveViewId(null);
		expect(() => folderTargets(['root'])).toThrow(/no active view/i);
	});
});

describe('folder edit gates', () => {
	it('folderEditLock sends edit intent with type:folder targets', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		expect(await folderEditLock(['f1', 'f2'])).toBe(true);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [
				{ resource_id: 'f1', mode: 'exclusive', type: 'folder' },
				{ resource_id: 'f2', mode: 'exclusive', type: 'folder' }
			],
			intent: 'edit'
		});
	});

	it('folderCreateLock sends create_child intent on the parent', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		expect(await folderCreateLock('f1')).toBe(true);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'f1', mode: 'exclusive', type: 'folder' }],
			intent: 'create_child'
		});
	});

	it('folderDeleteLock sends delete intent over the whole subtree', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		expect(await folderDeleteLock(['f1', 'f1a', 'f1b'])).toBe(true);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [
				{ resource_id: 'f1', mode: 'exclusive', type: 'folder' },
				{ resource_id: 'f1a', mode: 'exclusive', type: 'folder' },
				{ resource_id: 'f1b', mode: 'exclusive', type: 'folder' }
			],
			intent: 'delete'
		});
	});

	it('routes a folder-lock refusal through the global lock notice', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{ conflicts: [{ resource_id: 'folder:f1', held_by: 'bob', held_mode: 'exclusive' }] },
				'lock conflict'
			)
		);
		expect(await folderEditLock(['f1'])).toBe(false);
		expect(getLockNotice()).toBe('Locked by bob.');
	});
});
