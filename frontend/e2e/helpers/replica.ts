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

/** Records every phase the indicator shows from now on, in order. */
export async function watchPhases(page: Page): Promise<() => Promise<string[]>> {
	await page.evaluate(() => {
		const seen: string[] = [];
		const read = () =>
			document.querySelector('[data-testid="replica-indicator"]')?.getAttribute('data-phase') ??
			'none';
		seen.push(read());
		new MutationObserver(() => {
			const phase = read();
			if (seen[seen.length - 1] !== phase) seen.push(phase);
		}).observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['data-phase']
		});
		(window as unknown as { __replicaPhases: string[] }).__replicaPhases = seen;
	});
	return () =>
		page.evaluate(() => [...(window as unknown as { __replicaPhases: string[] }).__replicaPhases]);
}
