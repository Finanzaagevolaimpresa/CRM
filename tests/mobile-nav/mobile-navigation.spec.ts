import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    Object.assign(window, { mobileNavEvents: events });
    const describe = (target: EventTarget | null) => target instanceof HTMLElement
      ? { tag: target.tagName, text: target === document.body ? "body" : target.textContent?.trim().slice(0, 50), rects: target.getClientRects().length }
      : null;
    const record = (event: Event) => {
      events.push({
        event: event.type, time: Math.round(performance.now()),
        target: describe(event.target), active: describe(document.activeElement),
        related: event instanceof FocusEvent ? describe(event.relatedTarget) : null,
        width: innerWidth, scrollY, ready: document.readyState,
      });
      if (events.length > 80) events.shift();
    };
    for (const type of ["focusin", "focusout", "click", "wheel"]) document.addEventListener(type, record, true);
    for (const type of ["resize", "scroll", "load"]) window.addEventListener(type, record, true);
    window.matchMedia("(max-width: 767px)").addEventListener("change", record);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const diagnostics = await page.evaluate(() => {
    const describe = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { tag: element.tagName, className: element.className, top: box.top, height: box.height, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, overflowY: style.overflowY, display: style.display };
    };
    return {
      url: location.href, width: innerWidth, height: innerHeight, scrollY,
      body: describe(document.body), html: describe(document.documentElement),
      content: describe(document.querySelector('[data-testid="page-content"]')),
      underWheel: describe(document.elementFromPoint(innerWidth / 2, innerHeight - 30)),
      active: describe(document.activeElement),
      events: (window as Window & { mobileNavEvents?: unknown[] }).mobileNavEvents,
    };
  });
  console.log("MOBILE_NAV_FAILURE_STATE", JSON.stringify(diagnostics));
  await testInfo.attach("navigation-diagnostics", { body: JSON.stringify(diagnostics, null, 2), contentType: "application/json" });
});

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
    // Finish the router scroll restoration before issuing a new user scroll.
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await page.mouse.move(viewport.width / 2, viewport.height - 30);
    const scrollBeforeWheel = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 900);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollBeforeWheel);
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // Exercise an interactive control before checking effect-driven resize behavior.
  await page.getByRole("button", { name: "Apri menu" }).click();
  await expect(page.getByRole("button", { name: "Chiudi menu" })).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Apri menu" })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("link", { name: /Gestionale CRM/ })).toBeFocused();
  await page.getByRole("link", { name: "Audit log" }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Apri menu" })).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("link", { name: /Gestionale CRM/ })).toBeFocused();
  await expect(page.getByRole("link", { name: /Gestionale CRM/ })).toBeVisible();

  const outsideNavigation = page.getByRole("button", { name: "Fine contenuto" });
  await outsideNavigation.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(outsideNavigation).toBeFocused();

  await page.getByRole("link", { name: /Gestionale CRM/ }).focus();
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
