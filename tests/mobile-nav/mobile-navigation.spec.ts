import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
]) {
  test(`menu mobile accessibile ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?profile=admin");
    const trigger = page.getByRole("button", { name: "Apri menu" });
    const content = page.getByTestId("page-content");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(content).toBeInViewport();
    await expect(page.getByRole("link", { name: "Audit log" })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Chiudi menu" })).toHaveAttribute("aria-expanded", "true");
    const logout = page.getByRole("button", { name: "Logout" });
    await logout.scrollIntoViewIfNeeded();
    await expect(logout).toBeVisible();
    await expect(logout).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("link", { name: "Audit log" })).toBeHidden();

    await trigger.click();
    const finalAdminEntry = page.getByRole("link", { name: "Audit log" });
    await finalAdminEntry.scrollIntoViewIfNeeded();
    await expect(finalAdminEntry).toBeInViewport();
    expect(await page.getByRole("navigation", { name: "Navigazione principale" }).evaluate((nav) => nav.parentElement?.scrollTop ?? 0)).toBeGreaterThan(0);
    await finalAdminEntry.click();
    await expect(page).toHaveURL(/\/audit-log$/);
    await expect(page.getByRole("button", { name: "Apri menu" })).toHaveAttribute("aria-expanded", "false");
    await page.mouse.wheel(0, 900);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });
}

test("permessi Commerciale, testi lunghi, riapertura e desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?profile=commercial");
  await page.getByRole("button", { name: "Apri menu" }).click();
  await expect(page.getByRole("link", { name: "Checklist documentale" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lead e offerte" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Utenti" })).toHaveCount(0);
  await page.getByRole("button", { name: "Chiudi menu" }).click();
  await page.getByRole("button", { name: "Apri menu" }).click();
  await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: /menu/i })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Navigazione principale" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lead e offerte" })).toBeVisible();
});

test("resize conserva il focus su controlli visibili", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("link", { name: "Audit log" }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Apri menu" })).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("link", { name: /Gestionale CRM/ })).toBeFocused();
  await expect(page.getByRole("link", { name: /Gestionale CRM/ })).toBeVisible();
});

test("una route esterna e back non riaprono il menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Apri menu" }).click();
  await page.getByRole("link", { name: "Destinazione esterna al menu" }).evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page).toHaveURL(/\/external$/);
  await expect(page.getByRole("button", { name: "Apri menu" })).toHaveAttribute("aria-expanded", "false");
  await page.goBack();
  await expect(page.getByRole("button", { name: "Apri menu" })).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => {
    const focused = document.activeElement;
    return !focused || focused === document.body || focused.getClientRects().length > 0;
  })).toBe(true);
});
