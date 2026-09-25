import fs from "node:fs";
import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";

export const TIMEZONE = "Europe/Madrid";

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

export function createStatusCore({ nif, password, airtopApiKey, diagnosticsDir = "diagnostics" }) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!airtopApiKey) throw new Error("Missing AIRTOP_API_KEY");

  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const airtop = new AirtopClient({ apiKey: airtopApiKey });

  async function openWorkshift(page) {
    log("STATUS_STAGE=open-workshift");

    await page.goto(WORKSHIFT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    if (page.url().includes("/auth/login")) {
      log("STATUS_STAGE=login-form");

      const taxId = page.locator("#taxid").first();
      const passwordInput = page.locator("#password").first();

      await taxId.waitFor({ state: "visible", timeout: 120000 });
      await passwordInput.waitFor({ state: "visible", timeout: 120000 });

      await taxId.fill(nif);
      await passwordInput.fill(password);

      if ((await taxId.inputValue()).length !== nif.length) {
        throw new Error("Bilky status TaxID fill verification failed");
      }

      if ((await passwordInput.inputValue()).length !== password.length) {
        throw new Error("Bilky status password fill verification failed");
      }

      const submit = page.locator('button[type="submit"]').first();
      if (!(await submit.count())) throw new Error("Bilky status login button not found");

      log("STATUS_STAGE=submit-login");

      await submit.evaluate((el) => {
        const form = el.form;
        if (form && typeof form.requestSubmit === "function") form.requestSubmit(el);
        else el.click();
      });

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (!page.url().includes("/auth/login")) break;
        await sleep(300);
      }

      if (page.url().includes("/auth/login")) {
        throw new Error("Bilky status login did not complete");
      }

      const link = page
        .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
        .first();

      if (await link.count()) {
        log("STATUS_STAGE=dashboard-workshift");
        await link.evaluate((el) => el.click());
      }
    }

    const readyDeadline = Date.now() + 60000;
    while (Date.now() < readyDeadline) {
      if (page.url().includes("/employee/hour-registration/hour-registration/show/")) {
        const anyDay = page.locator('[id^="container_"]').first();
        if (await anyDay.count()) {
          log("STATUS_STAGE=workshift-ready");
          return;
        }
      }
      await sleep(300);
    }

    throw new Error(`Bilky status Workshift not ready; url=${page.url()}`);
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
    let sessionId = null;
    let browser = null;
    const captchaEvents = [];

    try {
      log("Bilky status: creating Airtop session solveCaptcha=true proxy=ES sticky=true");

      const session = await airtop.sessions.create({
        configuration: {
          solveCaptcha: true,
          proxy: { country: "ES", sticky: true },
          timeoutMinutes: 2,
        },
      });

      sessionId = session.data.id;
      if (!session.data.cdpWsUrl) throw new Error("Airtop status session missing cdpWsUrl");

      try {
        await airtop.sessions.onCaptchaEvent(sessionId, (event) => {
          captchaEvents.push(event);
          log(
            `STATUS CAPTCHA: status=${event?.status || "unknown"} type=${event?.type || "unknown"} durationMs=${event?.duration ?? "n/a"}`
          );
        });
      } catch (error) {
        log(`Status CAPTCHA event logging unavailable: ${String(error?.message || error).split("\n")[0].slice(0, 180)}`);
      }

      browser = await chromium.connectOverCDP(session.data.cdpWsUrl, {
        headers: { authorization: `Bearer ${airtopApiKey}` },
        timeout: 120000,
      });

      const context = browser.contexts()[0];
      if (!context) throw new Error("Airtop status browser context not found");

      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(120000);

      await openWorkshift(page);

      const setStage = (stage) => log(`STATUS_STAGE=${stage}`);
      const result = await operation({ page, setStage });

      if (captchaEvents.length) {
        fs.writeFileSync(
          `${diagnosticsDir}/status-captcha-events.json`,
          JSON.stringify(captchaEvents, null, 2),
          "utf8"
        );
      }

      return result;
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (sessionId) log(`Airtop status session cleanup bounded by timeoutMinutes=2: ${sessionId}`);
    }
  }

  return { readDayState, run };
}
