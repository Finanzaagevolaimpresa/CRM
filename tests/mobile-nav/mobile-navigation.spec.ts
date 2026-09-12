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
    const logout = page.getByRole("button", { name: "Esci dal CRM" });
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
    await page.mouse.wheel(0, -1600);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  });
}

test("permessi Commerciale, testi lunghi, riapertura e desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?profile=commercial");
  await page.getByRole("button", { name: "Apri menu" }).click();
  await expect(page.getByRole("link", { name: "Checklist documentale" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigazione principale" }).getByRole("link", { name: "Lead e offerte" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Utenti" })).toHaveCount(0);
  await page.getByRole("button", { name: "Chiudi menu" }).click();
  await page.getByRole("button", { name: "Apri menu" }).click();
  await expect(page.getByRole("button", { name: "Esci dal CRM" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: /menu/i })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Navigazione principale" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigazione principale" }).getByRole("link", { name: "Lead e offerte" })).toBeVisible();
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

test("dashboard responsive usa logo e azioni reali senza intrappolare lo scroll", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?profile=commercial");
  const logo = page.getByRole("img", { name: "Finanza Agevola Impresa" });
  await expect(logo).toBeVisible();
  const logoImage = await logo.evaluate((image: HTMLImageElement) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }));
  expect(logoImage.complete).toBe(true);
  expect(logoImage.width).toBeGreaterThan(0);
  expect(logoImage.height).toBeGreaterThan(0);
  expect(logoImage.width / logoImage.height).toBeCloseTo(971 / 567, 1);
  await expect(page.getByRole("link", { name: "Cerca nel CRM" })).toHaveAttribute("href", "/search");
  await expect(page.getByRole("link", { name: "Notifiche" })).toHaveAttribute("href", "/notifications");
  await expect(page.getByText("Autorizzazioni AI in attesa")).toHaveCount(0);
  await expect(page.getByText("Pratiche tecniche attive")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("dashboard-mobile-390x844.png"), fullPage: true });

  await page.mouse.wheel(0, 1200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.mouse.wheel(0, -1600);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole("button", { name: "Apri menu" }).click();
  await page.getByRole("button", { name: "Chiudi menu" }).click();
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.mouse.wheel(0, -1600);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?profile=admin");
  await expect(page.getByRole("heading", { name: "Buongiorno, Operatore." })).toBeVisible();
  await expect(page.getByRole("img", { name: "Finanza Agevola Impresa" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  // A fullPage capture alone cannot expose content inside the desktop scrollport.
  // Enlarge only the viewport for the artifact, preserving the application CSS.
  const overview = page.locator('[aria-labelledby="dashboard-heading"]');
  const overviewBox = await overview.boundingBox();
  if (!overviewBox) throw new Error("Dashboard overview has no measurable bounds");
  await page.setViewportSize({ width: 1440, height: Math.ceil(overviewBox.y + overviewBox.height + 24) });
  await expect.poll(() => overview.evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await testInfo.attach("dashboard-desktop-capture-viewport", {
    body: JSON.stringify({ checkedViewport: { width: 1440, height: 900 }, captureViewport: page.viewportSize() }),
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("dashboard-desktop-1440.png"), fullPage: true });
});

test("le priorità oltre la quinta restano consultabili", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/?profile=admin&priorities=many");
  await expect(page.getByRole("region", { name: "Priorità", exact: true }).getByRole("listitem")).toHaveCount(8);
  const lastPriority = page.getByRole("link", { name: /Attività sintetica 8/ });
  await lastPriority.scrollIntoViewIfNeeded();
  await expect(lastPriority).toBeInViewport();
  await expect(lastPriority).toHaveAttribute("href", "/tasks");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});


test("contatori per area mostrano i totali completi e le destinazioni", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?profile=admin");
  const areas = page.getByRole("region", { name: "Contatori per area" });
  await expect(areas.getByRole("heading", { level: 3 })).toHaveCount(6);
  const commercial = areas.getByRole("region", { name: "Commerciale", exact: true });
  await expect(commercial.getByRole("link", { name: /Lead da contattare/ })).toContainText("24");
  await expect(commercial.getByRole("link", { name: /Offerte inviate/ })).toHaveAttribute("href", "/commercial-offers");
  const reviews = areas.getByRole("region", { name: "Revisioni e autorizzazioni", exact: true });
  await expect(reviews.getByRole("link", { name: /Autorizzazioni AI in attesa/ })).toContainText("47");
  await expect(reviews.getByRole("link", { name: /Autorizzazioni AI in attesa/ })).toHaveAttribute("href", "/settings/ai-authorizations");
  const administration = areas.getByRole("region", { name: "Amministrazione", exact: true });
  await expect(administration.getByRole("link", { name: /Pagamenti aperti/ })).toContainText("7");
  await expect(administration).not.toContainText("€");
  const distribution = page.getByRole("img", { name: "Distribuzione dei servizi per stato", exact: true });
  await expect(distribution).toHaveAttribute("data-pipeline-total", "9");
  const shares = await distribution.locator("[data-pipeline-value]").evaluateAll((segments) => segments.map((segment) => Number(segment.getAttribute("data-pipeline-share"))));
  expect(shares).toHaveLength(3);
  for (const [index, count] of [4, 3, 2].entries()) expect(shares[index]).toBeCloseTo(count / 9 * 100, 6);
});

for (const profile of ["commercial", "technical", "restricted"]) {
  test(`contatori filtrati dal builder reale per profilo ${profile}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?profile=${profile}`);
    const areas = page.getByRole("region", { name: "Contatori per area" });
    if (profile === "restricted") {
      await expect(areas).toHaveCount(0);
      return;
    }
    await expect(areas.getByRole("region", { name: "Revisioni e autorizzazioni", exact: true })).toHaveCount(0);
    await expect(areas.getByRole("link", { name: /Clienti attivi|Progetti attivi/ })).toHaveCount(0);
    await expect(areas.getByRole("region", { name: "Ufficio Tecnico", exact: true })).toHaveCount(profile === "technical" ? 1 : 0);
    await expect(areas.getByRole("region", { name: "Commerciale", exact: true })).toHaveCount(profile === "commercial" ? 1 : 0);
    await expect(areas.getByRole("region", { name: "Amministrazione", exact: true })).toHaveCount(profile === "commercial" ? 1 : 0);
    const services = areas.getByRole("link", { name: /Servizi acquistati/ });
    await expect(services).toHaveAttribute("href", "/dashboard#pipeline-pratiche");
    await services.click();
    await expect(page).toHaveURL(/\/dashboard#pipeline-pratiche$/);
    await expect(page.locator("#pipeline-pratiche")).toBeInViewport();
  });
}

test("contatori zero restano visibili e numeri grandi non causano overflow mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/?profile=admin&counters=zero");
  const areas = page.getByRole("region", { name: "Contatori per area" });
  await expect(areas.getByRole("heading", { level: 3 })).toHaveCount(6);
  const counters = areas.getByRole("link");
  expect(await counters.count()).toBe(20);
  for (const link of await counters.all()) await expect(link).toHaveText(/0$/);
  const distribution = page.getByRole("img", { name: "Distribuzione dei servizi per stato", exact: true });
  await expect(distribution).toHaveAttribute("data-pipeline-total", "0");
  await expect(distribution.locator("[data-pipeline-value]")).toHaveCount(0);
  const emptyBars = await areas.locator("[data-counter-value]").evaluateAll((bars) => bars.map((bar) => ({
    value: bar.getAttribute("data-counter-value"),
    width: bar.getBoundingClientRect().width,
  })));
  expect(emptyBars.length).toBeGreaterThan(0);
  expect(emptyBars.every((bar) => bar.value === "0" && bar.width === 0)).toBe(true);
  await page.goto("/?profile=admin&counters=large");
  await expect(areas.getByRole("link").first()).toContainText("1.234.567");
  await expect(distribution).toHaveAttribute("data-pipeline-total", "3703701");
  const segments = distribution.locator("[data-pipeline-value]");
  await expect(segments).toHaveCount(3);
  const shares = await segments.evaluateAll((items) => items.map((item) => Number(item.getAttribute("data-pipeline-share"))));
  expect(shares.every((share) => Number.isFinite(share) && share > 0)).toBe(true);
  expect(shares[0]).toBeCloseTo(shares[1], 6);
  expect(shares[1]).toBeCloseTo(shares[2], 6);
  const barWidths = await areas.locator("[data-counter-value]").evaluateAll((bars) => bars.map((bar) => ({
    fill: bar.getBoundingClientRect().width,
    track: bar.parentElement?.getBoundingClientRect().width ?? 0,
  })));
  expect(barWidths.every((width) => Number.isFinite(width.fill) && width.fill > 0 && width.fill <= width.track + 0.5)).toBe(true);
  const lastCounter = areas.getByRole("link").last();
  await lastCounter.scrollIntoViewIfNeeded();
  await expect(lastCounter).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole("heading", { name: "Buongiorno, Operatore." }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("dashboard-counters-mobile-320.png"), fullPage: true });
});

test("i contatori delle comunicazioni restano leggibili senza autorizzare destinazioni", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/?profile=communications");
  const areas = page.getByRole("region", { name: "Contatori per area" });
  const technical = areas.getByRole("region", { name: "Ufficio Tecnico", exact: true });
  await expect(areas.getByRole("heading", { level: 3 })).toHaveCount(1);
  await expect(technical).toContainText("Comunicazioni da revisionare");
  await expect(technical).toContainText("Approvate non utilizzate");
  await expect(technical.getByText("5", { exact: true })).toBeVisible();
  await expect(technical.getByText("4", { exact: true })).toBeVisible();
  await expect(technical.getByText("Pratiche tecniche attive", { exact: true })).toHaveCount(0);
  await expect(technical.locator("a, button, [role='link'], [role='button']")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("la pipeline distingue i quattordici stati reali e mantiene legenda e proporzioni", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const statusLabels = [
    "nuova", "pre analisi", "documenti richiesti", "documenti ricevuti",
    "in valutazione", "proposta inviata", "domanda in preparazione", "domanda presentata",
    "in istruttoria", "approvata deliberata", "respinta non procedibile", "rendicontazione",
    "chiusa", "archiviata",
  ];
  const observedColors = new Map<string, string>();
  for (const scenario of [
    { query: "actual-sparse", labels: [statusLabels[0], statusLabels[6], statusLabels[12]], values: [4, 3, 2] },
    { query: "actual-all", labels: statusLabels, values: statusLabels.map((_, index) => index + 1) },
  ]) {
    await test.step(scenario.query, async () => {
      await page.goto(`/?profile=admin&pipeline=${scenario.query}`);
      const total = scenario.values.reduce((sum, value) => sum + value, 0);
      const distribution = page.getByRole("img", { name: "Distribuzione dei servizi per stato", exact: true });
      await expect(distribution).toHaveAttribute("data-pipeline-total", String(total));
      const segments = distribution.locator("circle[data-pipeline-value]");
      await expect(segments).toHaveCount(scenario.values.length);
      const renderedSegments = await segments.evaluateAll((circles) => circles.map((circle) => ({
        label: circle.getAttribute("data-pipeline-label"),
        value: Number(circle.getAttribute("data-pipeline-value")),
        stroke: getComputedStyle(circle).stroke,
        pathLength: Number(circle.getAttribute("pathLength")),
        arc: Number.parseFloat(circle.getAttribute("stroke-dasharray") ?? ""),
        offset: Number(circle.getAttribute("stroke-dashoffset")),
        title: circle.querySelector("title")?.textContent ?? "",
      })));
      expect(renderedSegments.map((segment) => segment.label)).toEqual(scenario.labels);
      expect(renderedSegments.map((segment) => segment.value)).toEqual(scenario.values);
      expect(new Set(renderedSegments.map((segment) => segment.stroke)).size).toBe(scenario.values.length);
      let expectedOffset = 0;
      for (const [index, segment] of renderedSegments.entries()) {
        expect(segment.stroke).not.toBe("none");
        expect(segment.stroke).not.toBe("rgba(0, 0, 0, 0)");
        expect(segment.pathLength).toBe(100);
        expect(segment.arc).toBeCloseTo(scenario.values[index] / total * 100, 6);
        expect(segment.offset).toBeCloseTo(-expectedOffset, 6);
        expect(segment.title).toContain(scenario.labels[index]);
        const previousColor = observedColors.get(scenario.labels[index]);
        if (previousColor) expect(segment.stroke).toBe(previousColor);
        observedColors.set(scenario.labels[index], segment.stroke);
        expectedOffset += scenario.values[index] / total * 100;
      }
      const boundaries = distribution.locator("line[data-pipeline-boundary]");
      await expect(boundaries).toHaveCount(scenario.values.length);
      const renderedBoundaries = await boundaries.evaluateAll((lines) => lines.map((line) => {
        const style = getComputedStyle(line);
        return {
          label: line.getAttribute("data-pipeline-boundary"),
          length: (line as SVGLineElement).getTotalLength(),
          stroke: style.stroke,
          strokeWidth: Number.parseFloat(style.strokeWidth),
          visibility: style.visibility,
          display: style.display,
        };
      }));
      expect(renderedBoundaries.map((boundary) => boundary.label)).toEqual(scenario.labels);
      for (const boundary of renderedBoundaries) {
        expect(boundary.length).toBeGreaterThan(0);
        expect(boundary.strokeWidth).toBeGreaterThan(0);
        expect(boundary.stroke).not.toBe("none");
        expect(boundary.stroke).not.toBe("rgba(0, 0, 0, 0)");
        expect(boundary.visibility).toBe("visible");
        expect(boundary.display).not.toBe("none");
      }
      const legend = page.locator("#pipeline-pratiche [data-pipeline-legend-label]");
      await expect(legend).toHaveCount(scenario.values.length);
      const renderedLegend = await legend.evaluateAll((entries) => entries.map((entry) => {
        const marker = entry.querySelector("[data-pipeline-legend-color]");
        return {
          label: entry.getAttribute("data-pipeline-legend-label"),
          color: marker ? getComputedStyle(marker).backgroundColor : null,
        };
      }));
      expect(renderedLegend.map((entry) => entry.label)).toEqual(scenario.labels);
      for (const [index, entry] of renderedLegend.entries()) expect(entry.color).toBe(renderedSegments[index].stroke);
      await legend.last().scrollIntoViewIfNeeded();
      await expect(legend.last()).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    });
  }
});
