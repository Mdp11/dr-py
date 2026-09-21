import { expect, type Locator, type Page } from '@playwright/test';

/** The status bar's replica indicator; its `data-*` attributes carry the state. */
export function replica(page: Page): Locator {
	return page.getByTestId('replica-indicator');
}

/**
 * Wait until the replica has opened. A fresh project's first descriptor may
 * write a snapshot on the server before the bytes can be served, hence the
 * long default.
 */
export async function expectReplicaReady(page: Page, timeout = 60_000): Promise<void> {
	await expect(replica(page)).toHaveAttribute('data-phase', 'ready', { timeout });
}

/** The replica's `rev` as the indicator shows it. */
export async function replicaRev(page: Page): Promise<number> {
	const rev = await replica(page).getAttribute('data-rev');
	if (rev === null) throw new Error('the replica indicator carries no rev');
	return Number(rev);
}
