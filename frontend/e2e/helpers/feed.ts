import { expect, type Page } from '@playwright/test';

/**
 * Wait for the realtime feed to report connected before interacting with the
 * workspace.
 *
 * Locate the StatusBar badge by its `title`, NOT by its text. The badge reads
 * "● live", and the obvious `page.getByText('live')` is a SUBSTRING match that
 * also catches the project-open ProgressOverlay's flavor text — "Reminding a
 * box that it lives inside another box…" (`lib/state/open-journey.ts`) contains
 * "live". When that particular spline happens to be on screen as the assertion
 * runs, the locator resolves to two elements and fails Playwright's strict-mode
 * check. Which spline is showing depends on timing, so the failure moved
 * between specs run to run and looked like generic flakiness.
 *
 * `getByTitle` is also substring-based, but "Live feed connected" is not a
 * substring of the disconnected variant ("Live feed disconnected"), so this
 * matches the connected state only — exactly what callers are waiting for.
 */
export async function expectLiveFeed(page: Page, timeout = 60_000): Promise<void> {
	await expect(page.getByTitle('Live feed connected')).toBeVisible({ timeout });
}
