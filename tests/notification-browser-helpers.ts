import { expect, type Page } from '@playwright/test';

export async function notificationCount(page: Page) {
  // Use the same browser request as the visible badge, including Chromium's
  // secure-cookie handling on the isolated HTTP loopback origin.
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/notifications/count', { cache: 'no-store', credentials: 'same-origin' });
    return { status: response.status, data: await response.json() as { count: number } };
  });
  expect(result.status).toBe(200);
  expect(Number.isSafeInteger(result.data.count)).toBe(true);
  expect(result.data.count).toBeGreaterThanOrEqual(0);
  return result.data.count;
}
