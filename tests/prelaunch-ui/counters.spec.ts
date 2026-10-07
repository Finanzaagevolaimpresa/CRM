import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const output = 'artifacts/prelaunch-ui/screenshots';
test.beforeAll(() => mkdirSync(output, { recursive: true }));
for (const width of [320, 768, 1440]) for (const scenario of ['positive', 'zero', 'large']) {
  test(`${width}px ${scenario}: actual counters, keyboard and reduced motion`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(scenario === 'positive' ? '/' : `/?${scenario}`);
    await expect(page.locator('[data-counter-final]')).toHaveCount(25);
    const proof = await page.locator('[data-counter-final]').evaluateAll(nodes => nodes.map(node => ({
      value: Number(node.getAttribute('data-counter-final')), visual: node.querySelector('[aria-hidden]')?.textContent,
      accessible: node.querySelector('.sr-only')?.textContent,
    })));
    for (const counter of proof) {
      expect(counter.accessible).toBe(counter.value.toLocaleString('it-IT'));
      expect(counter.visual).toBe(counter.accessible);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bars = await page.locator('[data-counter-width]').evaluateAll(nodes => nodes.map(node => ({
      value: Number(node.getAttribute('data-counter-value')), maximum: Number(node.getAttribute('data-counter-max')),
      width: Number(node.getAttribute('data-counter-width')), animation: getComputedStyle(node).animationName,
      hidden: node.parentElement?.getAttribute('aria-hidden'),
    })));
    for (const bar of bars) {
      expect(bar.width).toBe(bar.maximum ? bar.value / bar.maximum * 100 : 0);
      expect(bar.animation).toBe('none'); expect(bar.hidden).toBe('true');
    }
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    await expect(page.locator('a.crm-counter-hero').first()).toBeFocused();
    expect(await page.locator('a.crm-counter-hero').first().evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
    await page.screenshot({ path: join(output, `${width}-${scenario}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
test('motion finishes and preference change preserves the accessible value', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.goto('/?large');
  const counter = page.locator('[data-counter-final]').first();
  await expect(counter.locator('.sr-only')).toHaveText('123.456.789');
  await expect(counter.locator('[aria-hidden]')).toHaveText('123.456.789');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(counter.locator('[aria-hidden]')).toHaveText('123.456.789');
});
