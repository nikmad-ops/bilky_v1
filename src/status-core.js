import { chromium } from "playwright-core";

export const TIMEZONE = "Europe/Madrid";

const LOGIN_URL = "https://panel.bilky.es/auth/login";
const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";

export function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function minutesFromTime(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

export function formatDuration(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function factTime(value) {
  const match = String(value || "").match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );
  return match ? match[1] : null;
}

export function createStatusCore({ nif, password, browserlessToken }) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!browserlessToken) throw new Error("Missing BROWSERLESS_TOKEN");

  async function challengeDetected(page) {
    let title = "";
    try {
      title = await Promise.race([
        page.title(),
        sleep(750).then(() => ""),
      ]);
    } catch {}

    const frames = page.frames().map((frame) => frame.url()).join(" ");
    const signal = `${page.url()} ${title} ${frames}`.toLowerCase();

    return (
      signal.includes("just a moment") ||
      signal.includes("cdn-cgi/challenge-platform") ||
      signal.includes("challenges.cloudflare.com")
    );
  }

  async function waitSolver(page, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let clearSince = 0;

    while (Date.now() < deadline) {
      if (await challengeDetected(page)) {
        clearSince = 0;
      } else {
        if (!clearSince) clearSince = Date.now();
        if (Date.now() - clearSince >= 1200) return;
      }

      await sleep(400);
    }

    throw new Error("Cloudflare solver timeout");
  }

  async function openWorkshift(page, solverEnabled) {
    try {
      await page.goto(WORKSHIFT_URL, {
        waitUntil: "domcontentloaded",
        timeout: solverEnabled ? 45000 : 20000,
      });
    } catch (error) {
      if (!(await challengeDetected(page))) throw error;
    }

    if (await challengeDetected(page)) {
      if (!solverEnabled) throw new Error("Cloudflare blocked status read");
      await waitSolver(page);
    }

    if (page.url().includes("/auth/login")) {
      const inputs = page.locator("input:visible");
      if ((await inputs.count()) < 2) throw new Error("Bilky login fields not found");

      await inputs.nth(0).fill(nif);
      await page.locator('input[type="password"]').first().fill(password);
      await page.locator('button[type="submit"]').first().click({ noWaitAfter: true });

      if (await challengeDetected(page)) {
        if (!solverEnabled) throw new Error("Cloudflare blocked status login");
        await waitSolver(page);
      }

      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && page.url().includes("/auth/login")) {
        await sleep(300);
      }

      if (page.url().includes("/auth/login")) {
        throw new Error("Bilky status login did not complete");
      }

      const link = page
        .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
        .first();

      if (!(await link.count())) {
        throw new Error("Workshift link not found after status login");
      }

      await link.click({ noWaitAfter: true });

      if (await challengeDetected(page)) {
        if (!solverEnabled) throw new Error("Cloudflare blocked status Workshift");
        await waitSolver(page);
      }
    }
  }

  async function readDayState(page, date, { allowMissing = false } = {}) {
    const container = page.locator(`#container_${date}`);

    if (allowMissing && (await container.count()) === 0) {
      return { exists: false, error: "day container not found" };
    }

    await container.waitFor({ state: "visible", timeout: 10000 });

    const row = container
      .locator("tr")
      .filter({ hasText: /First shift|Primer turno/ })
      .first();

    if (!(await row.count())) {
      throw new Error(`First shift row not found for ${date}`);
    }

    const cells = row.locator("td.hr-container");
    if ((await cells.count()) < 2) {
      throw new Error(`Expected two shift cells for ${date}`);
    }

    const readFact = async (cell) => {
      const icon = cell.locator('i.fe-clock[data-original-title]').first();
      if (!(await icon.count())) return null;
      return factTime(await icon.getAttribute("data-original-title"));
    };

    const signed =
      (await container
        .locator(".badge-success")
        .filter({ hasText: /Signed|Firmado/ })
        .count()) > 0;

    return {
      exists: true,
      morning: { fact: await readFact(cells.nth(0)) },
      evening: { fact: await readFact(cells.nth(1)) },
      signed,
    };
  }

  async function run(operation) {
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const solverEnabled = attempt === 2;
      const params = new URLSearchParams({ token: browserlessToken });
      if (solverEnabled) params.set("solveCaptchas", "true");

      let browser = null;

      try {
        browser = await chromium.connectOverCDP(
          `wss://production-ams.browserless.io/stealth?${params.toString()}`
        );

        const context = browser.contexts()[0];
        const page = context.pages()[0] || (await context.newPage());

        await openWorkshift(page, solverEnabled);
        return await operation({ page });
      } catch (error) {
        lastError = error;
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }

    throw new Error(
      `Bilky status failed: ${String(lastError?.message || lastError || "Unknown error")}`
    );
  }

  return {
    readDayState,
    run,
  };
}
