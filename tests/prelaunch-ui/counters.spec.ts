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
      value: Number(node.getAttribute('data-counter-final')), visual: node.querySelector('[aria-hidden]')?.getAttribute('data-display-value'),
      accessible: node.querySelector('.sr-only')?.textContent,
      rendered: Array.from(node.querySelectorAll('[data-digit]')).map(digit => digit.getAttribute('data-digit')).join(''),
      fits: Array.from(node.querySelectorAll('[data-digit]')).every(digit => digit.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1),
    })));
    for (const counter of proof) {
      expect(counter.accessible).toBe(counter.value.toLocaleString('it-IT'));
      expect(counter.visual).toBe(counter.accessible);
      expect(counter.rendered).toBe(counter.accessible);
      expect(counter.fits).toBe(true);
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
test('digital count changes on screen, then settles on the exact accessible value', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?large');
  const counter = page.locator('[data-counter-final]').first();
  const display = counter.locator('[aria-hidden]');
  await expect(display).toHaveAttribute('data-phase', 'counting');
  await page.clock.runFor(150);
  await expect(counter.locator('.sr-only')).toHaveText('123.456.789');
  const intermediate = Number((await display.getAttribute('data-display-value'))!.replaceAll('.', ''));
  expect(intermediate).toBeGreaterThan(0); expect(intermediate).toBeLessThan(123456789);
  await page.clock.runFor(900);
  await expect(display).toHaveAttribute('data-display-value', '123.456.789');
  await expect(display).toHaveAttribute('data-phase', 'settled');
  await page.screenshot({ path: join(output, 'digital-motion-settled.png'), fullPage: true });
});

test('preference change stops an in-flight readout immediately', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.goto('/?large');
  const counter = page.locator('[data-counter-final]').first();
  await expect(counter.locator('[aria-hidden]')).toHaveAttribute('data-phase', 'counting');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(counter.locator('[aria-hidden]')).toHaveAttribute('data-display-value', '123.456.789');
  await expect(counter.locator('[aria-hidden]')).toHaveAttribute('data-phase', 'settled');
  await expect(counter.locator('.sr-only')).toHaveText('123.456.789');
});

test('below-fold readouts animate once on entry, not repeatedly while scrolling', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 768, height: 500 });
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.goto('/');
  const counter = page.locator('[aria-labelledby="counter-area-attivita-scadenze"] [data-counter-final]').first();
  const display = counter.locator('[aria-hidden]');
  await expect(display).toHaveAttribute('data-phase', 'settled');
  await counter.scrollIntoViewIfNeeded();
  await expect(display).toHaveAttribute('data-phase', 'counting');
  await page.clock.runFor(1000);
  await expect(display).toHaveAttribute('data-display-value', '27');
  await page.evaluate(() => window.scrollTo(0, 0));
  await counter.scrollIntoViewIfNeeded();
  await expect(display).toHaveAttribute('data-phase', 'settled');
});

test('forced colors keeps active segments distinct and zero remains a readable digit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.goto('/?zero');
  const digit = page.locator('[data-counter-final]').first().locator('svg[data-digit="0"]');
  await expect(digit).toHaveCount(1);
  const contrast = await digit.locator('polygon').evaluateAll(nodes => nodes.map(node => ({ lit: node.getAttribute('data-lit'), opacity: getComputedStyle(node).opacity })));
  expect(contrast.filter(segment => segment.lit === 'true')).toHaveLength(6);
  for (const segment of contrast) expect(segment.opacity).toBe(segment.lit === 'true' ? '1' : '0');
  await expect(page.locator('[data-counter-final]').first().locator('.sr-only')).toHaveText('0');
});
