import { chromium } from "playwright-core";
import fs from "node:fs";

export const LOGIN_URL = "https://panel.bilky.es/auth/login";
export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
export const TIMEZONE = "Europe/Madrid";

export function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function getMadridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function displayDate(date) {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

export function shortFact(time) {
  return time ? time.slice(0, 5) : "--:--";
}

export function minutesFromTime(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

export function formatDuration(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function dayDuration(morningFact, eveningFact) {
  const start = minutesFromTime(morningFact);
  const end = minutesFromTime(eveningFact);
  if (start == null || end == null || end < start) return null;
  return formatDuration(end - start);
}

function extractTime(text) {
  const match = String(text || "").match(/\b\d{2}:\d{2}\b/);
  return match ? match[0] : null;
}

function extractFactTime(value) {
  if (!value) return null;
  const match = String(value).match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortError(error) {
  return String(error?.message || error || "Unknown error")
    .split("\n")[0]
    .slice(0, 300);
}

export function createBilkyCore({
  nif,
  password,
  browserlessToken,
  diagnosticsDir = "diagnostics",
}) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!browserlessToken) throw new Error("Missing BROWSERLESS_TOKEN");

  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const captchaState = new WeakMap();

  function stateFor(page) {
    if (!captchaState.has(page)) {
      captchaState.set(page, {
        active: false,
        lastEventAt: 0,
        lastSolvedAt: 0,
      });
    }
    return captchaState.get(page);
  }

  async function attachBrowserlessCaptchaLogging(page) {
    const state = stateFor(page);

    try {
      const cdp = await page.context().newCDPSession(page);

      cdp.on("Browserless.captchaFound", (event) => {
        state.active = true;
        state.lastEventAt = Date.now();
        log(`Browserless CAPTCHA found: type=${event?.type || "unknown"} status=${event?.status || "found"}`);
      });

      cdp.on("Browserless.captchaAutoSolved", (event) => {
        state.active = !event?.solved;
        state.lastEventAt = Date.now();
        if (event?.solved) state.lastSolvedAt = Date.now();
        log(`Browserless CAPTCHA solved=${Boolean(event?.solved)} time=${event?.time ?? "unknown"}ms`);
      });
    } catch (error) {
      log(`Browserless CAPTCHA event logging unavailable: ${shortError(error)}`);
    }
  }

  async function securityVerificationDetected(page) {
    const state = stateFor(page);
    if (state.active) return true;

    let title = "";
    try {
      title = await Promise.race([
        page.title(),
        sleep(1000).then(() => ""),
      ]);
    } catch {}

    const frames = page.frames().map((frame) => frame.url()).join(" ").toLowerCase();
    const signal = `${page.url()} ${title} ${frames}`.toLowerCase();

    return (
      signal.includes("just a moment") ||
      signal.includes("cdn-cgi/challenge-platform") ||
      signal.includes("challenges.cloudflare.com")
    );
  }

  async function waitForSolverIdle(page, timeoutMs = 15000) {
    const state = stateFor(page);
    const deadline = Date.now() + timeoutMs;
    let clearSince = 0;

    while (Date.now() < deadline) {
      const challenge = await securityVerificationDetected(page);

      if (challenge) {
        clearSince = 0;
      } else {
        if (!clearSince) clearSince = Date.now();
        if (Date.now() - clearSince >= 1200) return;
      }

      await sleep(250);
    }

    throw new Error("Cloudflare solver did not reach a stable page");
  }

  function writeDiagnostic(attempt, stage, error, page) {
    const payload = {
      timestamp: new Date().toISOString(),
      attempt,
      stage,
      error: shortError(error),
      url: page ? page.url() : "",
    };

    try {
      fs.writeFileSync(
        `${diagnosticsDir}/attempt-${attempt}-${String(stage).replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`,
        JSON.stringify(payload, null, 2),
        "utf8"
      );
    } catch {}
  }

  async function openWorkshift(page, setStage, solverEnabled, date) {
    setStage("open-workshift");

    if (solverEnabled) {
      await waitForSolverIdle(page, 15000);
    }

    let lastNavigationError = null;

    for (let navAttempt = 1; navAttempt <= 2; navAttempt += 1) {
      if (solverEnabled) {
        // Cloudflare may finish the navigation itself after solving the challenge.
        // Give it a moment and do not start a competing page.goto() if we are
        // already on the requested workshift page.
        await sleep(2500);

        if (page.url().startsWith(WORKSHIFT_URL)) {
          log("Workshift URL already reached after CAPTCHA; skipping page.goto.");
          lastNavigationError = null;
          break;
        }
      }

      try {
        await page.goto(WORKSHIFT_URL, {
          waitUntil: "commit",
          timeout: solverEnabled ? 30000 : 15000,
        });
        lastNavigationError = null;
        break;
      } catch (error) {
        lastNavigationError = error;

        if (!solverEnabled || navAttempt === 2) {
          throw error;
        }

        log(`Workshift navigation interrupted; waiting for solver to settle before retry: ${shortError(error)}`);
        await waitForSolverIdle(page, 15000);

        if (page.url().startsWith(WORKSHIFT_URL)) {
          log("Workshift URL reached while solver settled; skipping retry page.goto.");
          lastNavigationError = null;
          break;
        }
      }
    }

    if (lastNavigationError) throw lastNavigationError;

    const container = page.locator(`#container_${date}`);
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      if (await container.isVisible().catch(() => false)) {
        log("Workshift ready.");
        return;
      }

      const challenge = await securityVerificationDetected(page);

      if (challenge && !solverEnabled) {
        throw new Error("Cloudflare security verification blocked Bilky page");
      }

      if (challenge && solverEnabled) {
        await waitForSolverIdle(page, 15000);
      }

      await sleep(300);
    }

    throw new Error("Bilky Workshift did not become ready");
  }

  async function loginAndOpenWorkshift(page, setStage, solverEnabled, date) {
    setStage("open-login");
    log("Opening Bilky login.");

    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    setStage("login-form");

    const visibleInputs = page.locator("input:visible");
    if ((await visibleInputs.count()) < 2) {
      throw new Error("Bilky login fields not found");
    }

    await visibleInputs.nth(0).fill(nif);
    await page.locator('input[type="password"]').first().fill(password);

    const submit = page.locator('button[type="submit"]').first();
    if (!(await submit.count())) {
      throw new Error("Bilky login button not found");
    }

    setStage("submit-login");
    await submit.click();

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(300);

      if (!page.url().includes("/auth/login")) break;

      const challenge = await securityVerificationDetected(page);
      if (challenge && !solverEnabled) {
        throw new Error("Cloudflare security verification blocked Bilky login");
      }
    }

    if (page.url().includes("/auth/login")) {
      throw new Error("Bilky login did not clear within 20 seconds");
    }

    log("Login OK.");

    if (solverEnabled) {
      await waitForSolverIdle(page, 15000);
    }

    await openWorkshift(page, setStage, solverEnabled, date);
  }

  async function readShiftCell(cell) {
    let planned = null;
    const input = cell.locator("input.clockpicker").first();

    if (await input.count()) {
      planned = await input.inputValue();
    } else {
      planned = extractTime(await cell.innerText());
    }

    let fact = null;
    let factRaw = null;
    const factIcon = cell.locator('i.fe-clock[data-original-title]').first();

    if (await factIcon.count()) {
      factRaw = await factIcon.getAttribute("data-original-title");
      fact = extractFactTime(factRaw);
    }

    const clockButton = cell.locator("a.clock").first();
    const buttonExists = (await clockButton.count()) > 0;
    let buttonEnabled = false;
    let buttonId = null;

    if (buttonExists) {
      const className = (await clockButton.getAttribute("class")) || "";
      buttonEnabled = !className.split(/\s+/).includes("disabled");
      buttonId = await clockButton.getAttribute("id");
    }

    return {
      planned,
      fact,
      factRaw,
      buttonExists,
      buttonEnabled,
      buttonId,
    };
  }

  async function readDayState(page, date, { allowMissing = false } = {}) {
    const containerSelector = `#container_${date}`;
    const container = page.locator(containerSelector);

    if (allowMissing && (await container.count()) === 0) {
      return { exists: false, error: "day container not found" };
    }

    await container.waitFor({
      state: "visible",
      timeout: 10000,
    });

    const row = container
      .locator("tr")
      .filter({ hasText: /First shift|Primer turno/ })
      .first();

    if (!(await row.count())) {
      throw new Error(`First shift row not found for ${date}`);
    }

    const shiftCells = row.locator("td.hr-container");
    if ((await shiftCells.count()) < 2) {
      throw new Error(`Expected morning and evening cells for ${date}`);
    }

    const morning = await readShiftCell(shiftCells.nth(0));
    const evening = await readShiftCell(shiftCells.nth(1));

    const signed =
      (await container
        .locator(".badge-success")
        .filter({ hasText: /Signed|Firmado/ })
        .count()) > 0;

    const signAvailable = (await container.locator("button#sign").count()) > 0;
    const text = await container.innerText();
    const pendingSignature = /pending signature|pendiente de firmar/i.test(text);

    return {
      exists: true,
      containerSelector,
      morning,
      evening,
      signed,
      signAvailable,
      pendingSignature,
      text,
    };
  }

  function printState(state) {
    log("----- DAY STATE -----");
    log(
      `Morning: plan=${state.morning.planned ?? "NONE"} fact=${state.morning.fact ?? "NONE"} button=${state.morning.buttonExists ? "YES" : "NO"} enabled=${state.morning.buttonEnabled}`
    );
    log(
      `Evening: plan=${state.evening.planned ?? "NONE"} fact=${state.evening.fact ?? "NONE"} button=${state.evening.buttonExists ? "YES" : "NO"} enabled=${state.evening.buttonEnabled}`
    );
    log(
      `Signed=${state.signed} SignAvailable=${state.signAvailable} PendingSignature=${state.pendingSignature}`
    );
    log("---------------------");
  }

  async function clock(page, state, mode, date, setStage) {
    const side = mode === "morning" ? state.morning : state.evening;
    const expectedPlan = mode === "morning" ? "08:00" : "16:00";

    if (side.fact) {
      log(`${mode}: already clocked at ${side.fact}. No duplicate click.`);
      return {
        alreadyDone: true,
        fact: side.fact,
        state,
      };
    }

    if (side.planned !== expectedPlan) {
      throw new Error(
        `${mode}: unexpected planned time ${side.planned}; expected ${expectedPlan}`
      );
    }

    if (!side.buttonExists) {
      throw new Error(`${mode}: Clock in/out button does not exist`);
    }

    if (!side.buttonEnabled) {
      throw new Error(`${mode}: Clock in/out button is disabled`);
    }

    if (mode === "evening" && !state.morning.fact) {
      throw new Error("Evening blocked because morning fact is missing");
    }

    const row = page
      .locator(state.containerSelector)
      .locator("tr")
      .filter({ hasText: /First shift|Primer turno/ })
      .first();

    const cells = row.locator("td.hr-container");
    const cell = mode === "morning" ? cells.nth(0) : cells.nth(1);
    const button = cell.locator("a.clock").first();

    setStage(`click-${mode}`);
    log(`CLICK ${mode}: ${side.buttonId}`);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/employee/hour-registration/clock-hour") &&
        response.request().method() === "POST",
      { timeout: 15000 }
    );

    await button.click();
    const response = await responsePromise;

    log(`clock-hour HTTP ${response.status()}`);

    if (!response.ok()) {
      throw new Error(`Bilky clock-hour returned HTTP ${response.status()}`);
    }

    log(`${mode}: HTTP 200 accepted. Waiting for Bilky page to expose the saved fact.`);

    // The clock-hour response can contain unrelated times. The authoritative
    // fact is the clock icon in the relevant shift cell after Bilky updates
    // the day container.
    let verifiedState = null;
    let fact = null;
    const factDeadline = Date.now() + 15000;

    while (Date.now() < factDeadline) {
      await sleep(500);

      try {
        verifiedState = await readDayState(page, date);
        fact =
          mode === "morning"
            ? verifiedState.morning.fact
            : verifiedState.evening.fact;
      } catch {}

      if (fact) {
        log(`${mode}: verified fact from page = ${fact}`);
        break;
      }
    }

    if (!fact) {
      throw new Error(`${mode}: HTTP 200 accepted but saved fact was not found in the Bilky page`);
    }

    return {
      alreadyDone: false,
      fact,
      state: verifiedState || state,
      httpAccepted: true,
    };
  }

  async function signDay(page, date, setStage, { eveningCompleted = false } = {}) {
    setStage("pre-sign");

    const container = page.locator(`#container_${date}`);
    const state = await readDayState(page, date);

    if (state.signed) {
      log("Day already SIGNED.");
      return {
        ...state,
        signAccepted: true,
      };
    }

    if (!state.evening.fact && !eveningCompleted) {
      throw new Error("Refusing to sign: evening fact is missing");
    }

    const signButton = container.locator("button#sign").first();

    if (!(await signButton.count())) {
      throw new Error("Evening completed but Sign button is unavailable");
    }

    setStage("click-sign");
    log("Clicking Sign.");
    await signButton.click();

    const confirmButton = page.locator(".sweet-alert:visible button.confirm").first();
    await confirmButton.waitFor({
      state: "visible",
      timeout: 8000,
    });

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/employee/hour-registration/update-registration") &&
        response.request().method() === "POST",
      { timeout: 15000 }
    );

    log("Confirming Sign.");
    await confirmButton.click();
    const response = await responsePromise;

    log(`update-registration HTTP ${response.status()}`);

    if (!response.ok()) {
      throw new Error(`Bilky Sign returned HTTP ${response.status()}`);
    }

    log("Sign HTTP 200 accepted. No reload/verification.");

    return {
      ...state,
      signed: true,
      signAccepted: true,
    };
  }

  async function safeClose(browser) {
    if (!browser) return;
    try {
      await Promise.race([
        browser.close(),
        sleep(2500),
      ]);
    } catch {}
  }

  async function runWithRetries(label, operation) {
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let browser = null;
      let page = null;
      let stage = "connect-browserless";
      const solverEnabled = attempt === 2;

      const setStage = (value) => {
        stage = value;
        log(`STAGE=${stage}`);
      };

      try {
        log(`${label}: attempt ${attempt}/2 starting`);
        log(
          `${label}: Browserless mode = ${solverEnabled ? "stealth + CAPTCHA solver" : "stealth only"}`
        );

        const browserlessUrl = solverEnabled
          ? `wss://production-ams.browserless.io/stealth?token=${browserlessToken}&solveCaptchas=true`
          : `wss://production-ams.browserless.io/stealth?token=${browserlessToken}`;

        browser = await chromium.connectOverCDP(browserlessUrl);

        const context = browser.contexts()[0] || (await browser.newContext());
        page = context.pages()[0] || (await context.newPage());

        await attachBrowserlessCaptchaLogging(page);

        await loginAndOpenWorkshift(
          page,
          setStage,
          solverEnabled,
          getMadridDate()
        );

        setStage("operation");

        const result = await operation({
          page,
          attempt,
          setStage,
        });

        log(`${label}: attempt ${attempt}/2 SUCCESS`);
        return result;
      } catch (error) {
        lastError = error;
        console.error(
          `${label}: attempt ${attempt}/2 FAILED at stage=${stage}: ${shortError(error)}`
        );

        writeDiagnostic(attempt, stage, error, page);

        if (attempt === 1) {
          log(`${label}: retrying immediately with CAPTCHA solver`);
        }
      } finally {
        await safeClose(browser);
      }
    }

    const finalError = new Error(
      `${label} failed after 2 attempts: ${shortError(lastError)}`
    );
    finalError.cause = lastError;
    throw finalError;
  }

  return {
    securityVerificationDetected,
    loginAndOpenWorkshift,
    readDayState,
    printState,
    clock,
    signDay,
    runWithRetries,
  };
}
