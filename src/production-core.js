import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";
import fs from "node:fs";

export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
export const TIMEZONE = "Europe/Madrid";

export function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function madridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayDuration(morning, evening) {
  if (!morning || !evening) return null;

  const toMinutes = (value) => {
    const [h, m] = value.slice(0, 5).split(":").map(Number);
    return h * 60 + m;
  };

  const start = toMinutes(morning);
  const end = toMinutes(evening);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  const total = end - start;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function factFromTitle(value) {
  const match = String(value || "").match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );
  return match ? match[1] : null;
}

export function factsFromHttp200(body) {
  const times = [...String(body || "").matchAll(/\b(\d{2}:\d{2}:\d{2})\b/g)]
    .map((match) => match[1]);

  return {
    morning: times[0] || null,
    evening: times[1] || null,
    all: times,
  };
}

export function createProductionClient({
  nif,
  password,
  airtopApiKey,
  attempt,
  diagnosticsDir = "diagnostics",
}) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!airtopApiKey) throw new Error("Missing AIRTOP_API_KEY");
  if (![1, 2, 3, 4, 5].includes(Number(attempt))) {
    throw new Error(`ATTEMPT must be 1..5. Got: ${attempt}`);
  }

  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const airtop = new AirtopClient({ apiKey: airtopApiKey });

  let sessionId = null;
  let browser = null;
  let context = null;
  let page = null;
  const captchaEvents = [];

  async function connect() {
    log(`Creating Airtop session. attempt=${attempt}/5 solveCaptcha=true proxy=ES sticky=true`);

    const session = await airtop.sessions.create({
      configuration: {
        solveCaptcha: true,
        proxy: {
          country: "ES",
          sticky: true,
        },
        timeoutMinutes: 2,
      },
    });

    sessionId = session.data.id;

    if (!session.data.cdpWsUrl) {
      throw new Error("Airtop session did not return cdpWsUrl");
    }

    log(`Airtop session ready: ${sessionId}`);

    try {
      await airtop.sessions.onCaptchaEvent(sessionId, (event) => {
        captchaEvents.push(event);
        const status = event?.status || "unknown";
        const type = event?.type || "unknown";
        const duration = event?.duration ?? "n/a";
        log(`CAPTCHA event: status=${status} type=${type} durationMs=${duration}`);
        fs.writeFileSync(
          `${diagnosticsDir}/captcha-events.json`,
          JSON.stringify(captchaEvents, null, 2),
          "utf8"
        );
      });
      log("Airtop CAPTCHA event logging enabled.");
    } catch (error) {
      log(
        `Airtop CAPTCHA event logging unavailable: ${String(error?.message || error)
          .split("\n")[0]
          .slice(0, 200)}`
      );
    }

    browser = await chromium.connectOverCDP(session.data.cdpWsUrl, {
      headers: {
        authorization: `Bearer ${airtopApiKey}`,
      },
      timeout: 120000,
    });

    context = browser.contexts()[0];
    if (!context) {
      throw new Error("Airtop default browser context not found");
    }

    page = context.pages()[0] || (await context.newPage());

    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(120000);
  }

  async function waitForState(date, timeoutMs = 120000) {
    const container = page.locator(`#container_${date}`);
    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
      .first();

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await container.isVisible().catch(() => false)) {
        return "workshift";
      }

      if (page.url().includes("/auth/login")) {
        return "login";
      }

      if (await workshiftLink.count()) {
        return "dashboard";
      }

      await sleep(500);
    }

    throw new Error(`Bilky state unresolved after navigation; url=${page.url()}`);
  }

  async function waitAfterLogin(date, timeoutMs = 45000) {
    const container = page.locator(`#container_${date}`);
    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
      .first();

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await container.isVisible().catch(() => false)) {
        return "workshift";
      }

      if (await workshiftLink.count()) {
        return "dashboard";
      }

      if (!page.url().includes("/auth/login")) {
        await sleep(300);
        continue;
      }

      await sleep(300);
    }

    throw new Error(`Bilky remained on login page after submit; url=${page.url()}`);
  }

  async function loginIfNeeded(date) {
    const state = await waitForState(date);

    if (state !== "login") {
      return state;
    }

    log("Bilky requested login.");

    const taxIdInput = page.locator("#taxid").first();
    const passwordInput = page.locator("#password").first();

    if (!(await taxIdInput.count()) || !(await passwordInput.count())) {
      throw new Error("Bilky login fields not found");
    }

    await taxIdInput.fill(nif);
    await passwordInput.fill(password);

    const taxIdOk = (await taxIdInput.inputValue()).length === nif.length;
    const passwordOk = (await passwordInput.inputValue()).length === password.length;

    log(`Login fields filled: taxId=${taxIdOk} password=${passwordOk}`);

    if (!taxIdOk || !passwordOk) {
      throw new Error("Bilky login field verification failed");
    }

    const submit = page.locator('button[type="submit"]').first();
    if (!(await submit.count())) {
      throw new Error("Bilky login button not found");
    }

    log("Submitting Bilky login form via requestSubmit (viewport-independent).");

    await submit.evaluate((el) => {
      const form = el.form;
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit(el);
      } else {
        el.click();
      }
    });

    return waitAfterLogin(date);
  }

  async function openWorkshift(date) {
    log("Opening direct Workshift URL through Airtop.");

    await page.goto(WORKSHIFT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    let state = await loginIfNeeded(date);

    if (state === "workshift") {
      log("Workshift ready.");
      return;
    }

    if (state === "dashboard") {
      const link = page
        .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
        .first();

      log("Dashboard detected; opening Workshift through visible navigation link.");
      await link.evaluate((el) => el.click());

      state = await waitForState(date);

      if (state === "login") {
        state = await loginIfNeeded(date);
      }

      if (state === "dashboard") {
        throw new Error("Bilky remained on dashboard after Workshift click");
      }

      if (state === "workshift") {
        log("Workshift ready.");
        return;
      }
    }

    throw new Error(`Unable to reach Bilky Workshift; final state=${state}; url=${page.url()}`);
  }

  async function targetCells(mode, date) {
    const row = page
      .locator(`#container_${date}`)
      .locator("tr")
      .filter({ hasText: /First shift|Primer turno/ })
      .first();

    if (!(await row.count())) {
      throw new Error(`First shift row not found for ${date}`);
    }

    const cells = row.locator("td.hr-container");
    const index = mode === "morning" ? 0 : 1;

    if ((await cells.count()) <= index) {
      throw new Error(`${mode}: target cell not found`);
    }

    return {
      cell: cells.nth(index),
      cells,
    };
  }

  async function readFact(cell) {
    const icon = cell.locator('i.fe-clock[data-original-title]').first();
    if (!(await icon.count())) return null;
    return factFromTitle(await icon.getAttribute("data-original-title"));
  }

  async function inspect(mode, date) {
    await connect();

    try {
      await openWorkshift(date);
      const { cell, cells } = await targetCells(mode, date);

      const fact = await readFact(cell);
      const button = cell.locator("a.clock").first();
      const buttonExists = (await button.count()) > 0;

      let morningFact = null;
      if (mode === "morning") {
        morningFact = fact;
      } else {
        morningFact = await readFact(cells.nth(0));
      }

      return {
        action: mode,
        fact,
        morningFact,
        eveningFact: mode === "evening" ? fact : null,
        buttonExists,
        url: page.url(),
      };
    } finally {
      await close();
    }
  }

  async function execute(mode, date) {
    await connect();

    try {
      await openWorkshift(date);

      const { cell, cells } = await targetCells(mode, date);
      const alreadyFact = await readFact(cell);

      if (alreadyFact) {
        const morningFact =
          mode === "morning" ? alreadyFact : await readFact(cells.nth(0));

        return {
          success: true,
          status: "already_done",
          action: mode,
          fact: alreadyFact,
          morningFact,
          eveningFact: mode === "evening" ? alreadyFact : null,
          duration:
            mode === "evening"
              ? dayDuration(morningFact, alreadyFact)
              : null,
          httpStatus: null,
          attempt: Number(attempt),
          provider: "airtop",
        };
      }

      const button = cell.locator("a.clock").first();

      if (!(await button.count())) {
        throw new Error(`${mode}: button missing and existing fact not found`);
      }

      const className = (await button.getAttribute("class")) || "";
      if (className.split(/\s+/).includes("disabled")) {
        throw new Error(`${mode}: Clock in/out button is disabled`);
      }

      log(`CLICK ${mode}: authorized production click via Airtop.`);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/employee/hour-registration/clock-hour") &&
          response.request().method() === "POST",
        { timeout: 20000 }
      );

      await cell.scrollIntoViewIfNeeded().catch(() => {});
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(300);

      try {
        await button.click({ timeout: 10000 });
      } catch (error) {
        log(
          `Clock button standard click failed; using DOM click fallback: ${String(error?.message || error)
            .split("\n")[0]
            .slice(0, 180)}`
        );
        await button.evaluate((el) => el.click());
      }

      const response = await responsePromise;

      log(`clock-hour HTTP ${response.status()}`);

      if (response.status() !== 200) {
        throw new Error(
          `Bilky clock-hour returned HTTP ${response.status()}`
        );
      }

      fs.writeFileSync(
        "run-committed.json",
        JSON.stringify(
          {
            date,
            action: mode,
            provider: "airtop",
            httpStatus: 200,
            attempt: Number(attempt),
            committedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );

      let body = "";
      let bodyReadError = null;

      try {
        body = await response.text();
        fs.writeFileSync(
          `${diagnosticsDir}/clock-${mode}-http-200-body.html`,
          body,
          "utf8"
        );
      } catch (error) {
        bodyReadError = String(error?.message || error || "Unknown error")
          .split("\n")[0]
          .slice(0, 300);
      }

      const facts = factsFromHttp200(body);
      const fact =
        mode === "morning" ? facts.morning : facts.evening;

      return {
        success: true,
        status: "clicked",
        action: mode,
        fact,
        morningFact: facts.morning,
        eveningFact: facts.evening,
        duration:
          mode === "evening"
            ? dayDuration(facts.morning, facts.evening)
            : null,
        httpStatus: 200,
        factParseError: !fact,
        responseBodyError: bodyReadError,
        responseTimesFound: facts.all.length,
        attempt: Number(attempt),
        provider: "airtop",
      };
    } finally {
      await close();
    }
  }

  async function close() {
    if (browser) {
      log("Closing Airtop browser connection.");
      await browser.close().catch((error) => {
        log(`Airtop browser close warning: ${String(error?.message || error).split("\n")[0].slice(0, 200)}`);
      });
    }

    if (sessionId) {
      log(`Airtop session cleanup bounded by timeoutMinutes=2: ${sessionId}`);
    }

    if (captchaEvents.length) {
      fs.writeFileSync(
        `${diagnosticsDir}/captcha-events.json`,
        JSON.stringify(captchaEvents, null, 2),
        "utf8"
      );
    }

    browser = null;
    context = null;
    page = null;
    sessionId = null;
  }

  return {
    inspect,
    execute,
    close,
  };
}
