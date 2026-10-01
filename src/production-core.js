import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";
import fs from "node:fs";

export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
export const TIMEZONE = "Europe/Madrid";

const AIRTOP_SESSION_BUDGET_MS = 28000;
const CAPTCHA_SOLVER_BUDGET_MS = 25000;
const POST_LOGIN_STATE_TIMEOUT_MS = 8000;
const FORENSIC_CAPTURE_BUDGET_MS = 1500;
const AIRTOP_PROFILE_NAME = process.env.AIRTOP_PROFILE_NAME || "bilky-nik";

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
  const recentNetwork = [];
  let sessionReadyAt = 0;
  let sessionDeadline = 0;
  let captchaDetectedAt = 0;
  let captchaSolvedAt = 0;

  async function connect() {
    log(`Creating Airtop session. attempt=${attempt}/5 solveCaptcha=true proxy=ES sticky=true`);

    const session = await airtop.sessions.create({
      configuration: {
        solveCaptcha: true,
        proxy: {
          country: "ES",
          sticky: true,
        },
        timeoutMinutes: 1,
        profileName: AIRTOP_PROFILE_NAME,
        persistProfile: true,
      },
    });

    sessionId = session.data.id;

    if (!session.data.cdpWsUrl) {
      throw new Error("Airtop session did not return cdpWsUrl");
    }

    sessionReadyAt = Date.now();
    sessionDeadline = sessionReadyAt + AIRTOP_SESSION_BUDGET_MS;

    log(
      `Airtop session ready: ${sessionId}; budget=${AIRTOP_SESSION_BUDGET_MS}ms profile=${AIRTOP_PROFILE_NAME}`
    );

    try {
      await airtop.sessions.onCaptchaEvent(sessionId, (event) => {
        captchaEvents.push(event);
        const status = event?.status || "unknown";
        const type = event?.type || "unknown";
        const duration = event?.duration ?? "n/a";

        if (status === "detected" || status === "processing") {
          if (!captchaDetectedAt) captchaDetectedAt = Date.now();
        }

        if (status === "completed" || event?.solved === true) {
          captchaSolvedAt = Date.now();
        }

        if (status === "failed") {
          captchaDetectedAt = captchaDetectedAt || Date.now();
        }

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

    page.on("request", (request) => {
      recentNetwork.push({
        at: new Date().toISOString(),
        kind: "request",
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
      });
      if (recentNetwork.length > 40) recentNetwork.splice(0, recentNetwork.length - 40);
    });

    page.on("response", (response) => {
      recentNetwork.push({
        at: new Date().toISOString(),
        kind: "response",
        status: response.status(),
        url: response.url(),
      });
      if (recentNetwork.length > 40) recentNetwork.splice(0, recentNetwork.length - 40);
    });

    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(AIRTOP_SESSION_BUDGET_MS);
  }

  function remainingSessionMs() {
    if (!sessionDeadline) return AIRTOP_SESSION_BUDGET_MS;
    return Math.max(0, sessionDeadline - Date.now());
  }

  function assertSessionBudget(stage) {
    const remaining = remainingSessionMs();

    if (captchaDetectedAt && !captchaSolvedAt) {
      const captchaAge = Date.now() - captchaDetectedAt;
      if (captchaAge >= CAPTCHA_SOLVER_BUDGET_MS) {
        throw new Error(
          `CAPTCHA solver budget exceeded at ${stage}: ${captchaAge}ms >= ${CAPTCHA_SOLVER_BUDGET_MS}ms`
        );
      }
    }

    if (remaining <= 0) {
      throw new Error(
        `Airtop session budget exceeded at ${stage}: ${AIRTOP_SESSION_BUDGET_MS}ms`
      );
    }

    return remaining;
  }

  async function withinSessionBudget(operation, stage = "operation") {
    const remaining = assertSessionBudget(stage);

    return Promise.race([
      operation(),
      new Promise((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Airtop session budget exceeded at ${stage}: ${AIRTOP_SESSION_BUDGET_MS}ms`
              )
            ),
          remaining
        );
      }),
    ]);
  }

  async function waitForState(date, timeoutMs = AIRTOP_SESSION_BUDGET_MS) {
    const container = page.locator(`#container_${date}`);
    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
      .first();

    const deadline = Math.min(Date.now() + timeoutMs, sessionDeadline || Infinity);

    while (Date.now() < deadline) {
      assertSessionBudget("waitForState");
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

  async function captureForensic(reason, date) {
    if (!page) return;

    const safe = async (operation, fallback = null) => {
      try {
        return await operation();
      } catch {
        return fallback;
      }
    };

    const capture = async () => {
      const url = page.url();
      const title = await safe(() => page.title(), "");
      const readyState = await safe(
        () => page.evaluate(() => document.readyState),
        "unknown"
      );

      const fingerprint = await safe(
        () =>
          page.evaluate((targetDate) => {
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return (
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                rect.width > 0 &&
                rect.height > 0
              );
            };

            const text = document.body?.innerText || "";
            const html = document.documentElement?.outerHTML || "";
            const cloudflare =
              /cloudflare|cf-chl|challenge-platform|turnstile/i.test(
                `${text}\n${html}`
              );

            return {
              url: location.href,
              title: document.title,
              readyState: document.readyState,
              hasLoginTaxId: Boolean(document.querySelector("#taxid")),
              hasLoginPassword: Boolean(document.querySelector("#password")),
              visibleSubmitButtons: Array.from(
                document.querySelectorAll('button[type="submit"]')
              ).filter(visible).length,
              visibleWorkshiftLinks: Array.from(
                document.querySelectorAll(
                  'a[href*="/employee/hour-registration/hour-registration/show/"]'
                )
              ).filter(visible).length,
              hasDateContainer: Boolean(
                document.querySelector(`#container_${targetDate}`)
              ),
              clockButtons: document.querySelectorAll("a.clock").length,
              signButtons: document.querySelectorAll("button#sign").length,
              successBadges: document.querySelectorAll(".badge-success").length,
              cloudflareMarkers: cloudflare,
              bodyTextSample: text.slice(0, 3000),
            };
          }, date),
        null
      );

      const sanitizedDom = await safe(
        () =>
          page.evaluate(() => {
            const clone = document.documentElement.cloneNode(true);
            for (const input of clone.querySelectorAll("input")) {
              input.removeAttribute("value");
              if (input.getAttribute("type") === "password") {
                input.setAttribute("value", "[REDACTED]");
              }
            }
            for (const el of clone.querySelectorAll(
              '[name*="password" i],[id*="password" i],[autocomplete="current-password"]'
            )) {
              el.removeAttribute("value");
              el.textContent = "";
            }
            return "<!doctype html>\n" + clone.outerHTML;
          }),
        ""
      );

      const payload = {
        capturedAt: new Date().toISOString(),
        reason,
        date,
        url,
        title,
        readyState,
        captchaEvents,
        fingerprint,
        recentNetwork: recentNetwork.slice(-40),
      };

      fs.writeFileSync(
        `${diagnosticsDir}/forensic-${reason}.json`,
        JSON.stringify(payload, null, 2),
        "utf8"
      );

      if (sanitizedDom) {
        fs.writeFileSync(
          `${diagnosticsDir}/forensic-${reason}.html`,
          sanitizedDom,
          "utf8"
        );
      }

      await safe(
        () =>
          page.screenshot({
            path: `${diagnosticsDir}/forensic-${reason}.png`,
            fullPage: false,
          }),
        null
      );

      log(
        `Forensic snapshot captured: reason=${reason} url=${url} readyState=${readyState}`
      );
    };

    await Promise.race([
      capture(),
      new Promise((resolve) =>
        setTimeout(resolve, FORENSIC_CAPTURE_BUDGET_MS)
      ),
    ]).catch(() => {});

    log(
      `Forensic capture finished/bounded: reason=${reason} budget=${FORENSIC_CAPTURE_BUDGET_MS}ms`
    );
  }

  async function waitAfterLogin(
    date,
    timeoutMs = POST_LOGIN_STATE_TIMEOUT_MS
  ) {
    const container = page.locator(`#container_${date}`);
    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
      .first();

    const deadline = Math.min(Date.now() + timeoutMs, sessionDeadline || Infinity);

    while (Date.now() < deadline) {
      assertSessionBudget("waitAfterLogin");

      if (await container.isVisible().catch(() => false)) {
        return "workshift";
      }

      if (await workshiftLink.count()) {
        return "dashboard";
      }

      await sleep(250);
    }

    await captureForensic("post-login-timeout", date);

    throw new Error(
      `Bilky post-login state unresolved after ${timeoutMs}ms; url=${page.url()}`
    );
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

    await withinSessionBudget(
      () =>
        page.goto(WORKSHIFT_URL, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1000, remainingSessionMs()),
        }),
      "openWorkshift.goto"
    );

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

  async function findShiftRow(date) {
    const container = page.locator(`#container_${date}`);
    const rows = container.locator("tr");
    const count = await rows.count();
    const candidates = [];

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const cells = row.locator("td.hr-container");
      if ((await cells.count()) < 2) continue;

      const plans = [];
      for (let j = 0; j < 2; j += 1) {
        const cell = cells.nth(j);
        const input = cell.locator("input.clockpicker").first();
        let value = "";
        if (await input.count()) {
          value = await input.inputValue().catch(() => "");
        }
        if (!value) {
          const text = await cell.innerText().catch(() => "");
          const match = String(text).match(/\b([01]\d|2[0-3]):[0-5]\d\b/);
          value = match ? match[0] : "";
        }
        plans.push(value.slice(0, 5));
      }

      if (plans[0] === "08:00" && plans[1] === "16:00") {
        return row;
      }

      candidates.push(row);
    }

    if (candidates.length === 1) return candidates[0];

    throw new Error(
      `Shift row not found structurally for ${date}; candidates=${candidates.length}`
    );
  }

  async function targetCells(mode, date) {
    const row = await findShiftRow(date);
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
      return await withinSessionBudget(async () => {
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
      }, "execute");
    } finally {
      await close();
    }
  }

  async function terminateAirtopSession(id) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(
        `https://api.airtop.ai/api/v1/sessions/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${airtopApiKey}`,
          },
          signal: controller.signal,
        }
      );

      if (response.status !== 204) {
        throw new Error(`Airtop terminate HTTP ${response.status}`);
      }

      log(`Airtop session terminated explicitly: ${id}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function close() {
    const activeSessionId = sessionId;

    if (activeSessionId) {
      await terminateAirtopSession(activeSessionId).catch((error) => {
        log(
          `Airtop REST terminate warning: ${String(error?.message || error)
            .split("\n")[0]
            .slice(0, 200)}`
        );
      });
    }

    if (browser) {
      await browser.close().catch(() => {});
    }

    if (captchaEvents.length) {
      fs.writeFileSync(
        `${diagnosticsDir}/captcha-events.json`,
        JSON.stringify(captchaEvents, null, 2),
        "utf8"
      );
    }

    if (sessionReadyAt) {
      log(`Airtop active session duration: ${Date.now() - sessionReadyAt}ms`);
    }

    browser = null;
    context = null;
    page = null;
    sessionId = null;
    sessionReadyAt = 0;
    sessionDeadline = 0;
    captchaDetectedAt = 0;
    captchaSolvedAt = 0;
  }

  return {
    inspect,
    execute,
    close,
  };
}
