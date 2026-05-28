import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
const tree = page.getByRole('tree', { name: /containment tree/i });
await tree.getByText('Organizations', { exact: true }).first().waitFor({ timeout: 15000 });
await page.evaluate(() => {
  window.__ev = [];
  document.addEventListener('dragstart', (e) => window.__ev.push('dragstart:' + e.target.tagName), true);
});
async function dragFrom(box, label) {
  await page.evaluate(() => { window.__ev = []; });
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.move(box.x + 80, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  console.log(label, JSON.stringify(await page.evaluate(() => window.__ev)));
}
const elemRow = page.locator('[role="treeitem"]').filter({ has: page.locator('button[title]') }).first();
await dragFrom(await elemRow.boundingBox(), 'element row far-left grab:');
const folderRow = page.locator('[role="treeitem"]').filter({ hasText: 'Systems' }).first();
await dragFrom(await folderRow.boundingBox(), 'folder row far-left grab:');
await browser.close();
