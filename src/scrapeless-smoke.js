import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const LOGIN_URL = "https://panel.bilky.es/auth/login";
const TIMEZONE = "Europe/Madrid";

const token = process.env.SCRAPELESS_API_KEY;
const nif = process.env.BILKY_NIF;
const password = process.env.BILKY_PASSWORD;
const clientId = process.env.CLIENT_ID || "unknown";
const runId = process.env.GITHUB_RUN_ID || String(Date.now());

if (!token) throw new Error("Missing SCRAPELESS_API_KEY");
if (!nif) throw new Error("Missing BILKY_NIF");
if (!password) throw new Error("Missing BILKY_PASSWORD");
const diagnosticsRoot = path.resolve(
  process.env.DIAGNOSTICS_DIR || "scrapeless-diagnostics"
);
const runDir = path.join(diagnosticsRoot, `${clientId}-${runId}`);
fs.mkdirSync(runDir, { recursive: true });

const startedAt = Date.now();
const timeline = [];
const network = [];
const consoleEvents = [];
let browser;
let context;
let page;
let cdp;

function log(message, extra = undefined) {
  const entry = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    message,
    ...(extra === undefined ? {} : { extra }),
  };
  timeline.push(entry);
  console.log(
    `[${entry.at}] +${entry.elapsedMs}ms ${message}${
      extra === undefined ? "" : ` ${JSON.stringify(extra)}`
    }`
  );
  persist();
}

function safeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

function persist() {
  fs.writeFileSync(
    path.join(runDir, "timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  fs.writeFileSync(
    path.join(runDir, "network.json"),
    JSON.stringify(network, null, 2)
  );
  fs.writeFileSync(
    path.join(runDir, "console-events.json"),
    JSON.stringify(consoleEvents, null, 2)
  );
}

function madridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function snapshot(step) {
  if (!page) return null;

  const state = await page
    .evaluate((today) => {
      const text = document.body?.innerText || "";
      const html = document.documentElement?.outerHTML || "";
      const clone = document.documentElement?.cloneNode(true);

      if (clone) {
        for (const el of clone.querySelectorAll("input,textarea")) {
          el.removeAttribute("value");
          if ("value" in el) {
            try {
              el.value = "";
            } catch {}
          }
        }
      }

      const challengeText =
        /just a moment|verify you are human|security verification|performing security verification/i.test(
          text
        );

      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextPreview: text.slice(0, 1800),
        fingerprint: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          webdriver: navigator.webdriver,
          language: navigator.language,
          languages: navigator.languages,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen: {
            width: screen.width,
            height: screen.height,
            dpr: devicePixelRatio,
          },
        },
        indicators: {
          loginTaxId: Boolean(document.querySelector("#taxid")),
          loginPassword: Boolean(document.querySelector("#password")),
          workshiftLinks: document.querySelectorAll(
            'a[href*="/employee/hour-registration/hour-registration/show/"]'
          ).length,
          todayContainer: Boolean(document.querySelector(`#container_${today}`)),
          clockButtons: document.querySelectorAll("a.clock").length,
          factIcons: document.querySelectorAll(
            'i.fe-clock[data-original-title]'
          ).length,
          turnstile: Boolean(
            document.querySelector(
              '[name="cf-turnstile-response"],iframe[src*="turnstile"]'
            )
          ),
          cfChallengeElement: Boolean(
            document.querySelector(
              '[id*="cf-chl"],[class*="cf-chl"],[data-cf-chl]'
            )
          ),
          challengeText,
          challengeScript: /\/cdn-cgi\/challenge-platform\//i.test(html),
        },
        sanitizedHtml: clone ? "<!doctype html>\n" + clone.outerHTML : "",
      };
    }, madridDate())
    .catch((error) => ({
      url: safeUrl(page.url()),
      title: "",
      snapshotError: String(error?.message || error),
    }));

  const cookies = context
    ? await context.cookies().catch(() => [])
    : [];

  const payload = {
    step,
    capturedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    state: {
      ...state,
      url: safeUrl(state.url),
      cookieNames: cookies.map((c) => c.name).sort(),
      sanitizedHtml: undefined,
    },
  };

  fs.writeFileSync(
    path.join(runDir, `${step}.json`),
    JSON.stringify(payload, null, 2)
  );

  if (state.sanitizedHtml) {
    fs.writeFileSync(
      path.join(runDir, `${step}.html`),
      state.sanitizedHtml
    );
  }

  await page
    .screenshot({
      path: path.join(runDir, `${step}.png`),
      fullPage: false,
      timeout: 3000,
    })
    .catch((error) =>
      log(`Screenshot failed at ${step}`, {
        error: String(error?.message || error).split("\n")[0],
      })
    );

  log(`SNAPSHOT ${step}`, payload.state);
  return payload.state;
}

async function waitForPostLoginState(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    const url = page.url();
    const workshiftLinks = await page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
      .count()
      .catch(() => 0);

    if (workshiftLinks > 0) return "dashboard";
    if (
      url.includes("/employee/dashboard/") ||
      url.includes("/employee/control/panel")
    ) {
      return "dashboard";
    }

    if (title === "Just a moment...") {
      log("Cloudflare interstitial visible; waiting for Scrapeless browser");
    }

    await page.waitForTimeout(750);
  }
  return "timeout";
}

function attachPageLogging() {
  page.on("request", (request) => {
    const url = safeUrl(request.url());
    if (
      url.includes("panel.bilky.es") ||
      url.includes("cloudflare") ||
      url.includes("challenges.cloudflare.com")
    ) {
      network.push({
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        type: "request",
        method: request.method(),
        resourceType: request.resourceType(),
        url,
      });
      persist();
    }
  });

  page.on("response", (response) => {
    const url = safeUrl(response.url());
    if (
      url.includes("panel.bilky.es") ||
      url.includes("cloudflare") ||
      url.includes("challenges.cloudflare.com")
    ) {
      const entry = {
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        type: "response",
        status: response.status(),
        method: response.request().method(),
        url,
      };
      network.push(entry);
      console.log(
        `NET ${entry.status} ${entry.method} ${entry.url}`
      );
      persist();
    }
  });

  page.on("console", (msg) => {
    consoleEvents.push({
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      type: msg.type(),
      text: msg.text().slice(0, 1000),
    });
    persist();
  });

  page.on("pageerror", (error) => {
    consoleEvents.push({
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      type: "pageerror",
      text: String(error?.message || error).slice(0, 1000),
    });
    persist();
  });
}

async function main() {
  const sessionName = `bilky-${clientId}-${runId}`;
  const params = new URLSearchParams({
    token,
    sessionTTL: "180",
    sessionName,
    sessionRecording: "true",
    proxyCountry: "ES",
  });

  const wsEndpoint = `wss://browser.scrapeless.com/api/v2/browser?${params.toString()}`;

  log("Scrapeless smoke start", {
    clientId,
    provider: "scrapeless",
    endpoint: "browser.scrapeless.com/api/v2/browser",
    sessionName,
    sessionTTL: 180,
    sessionRecording: true,
    proxyCountry: "ES",
    maxSessionsThisRun: 1,
    writeActionsEnabled: false,
  });

  browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 20000 });
  context = browser.contexts()[0];
  if (!context) throw new Error("Scrapeless default context not found");

  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);
  attachPageLogging();

  cdp = await context.newCDPSession(page);

  await snapshot("00-connected");

  log("STEP 1 open login page", { url: LOGIN_URL });
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForTimeout(1200);
  let state = await snapshot("01-login");

  if (state?.indicators?.challengeText || state?.title === "Just a moment...") {
    log("Challenge present on login page; waiting up to 20s for Scrapeless");
    await page.waitForTimeout(20000);
    state = await snapshot("02-login-after-solver-wait");
  }

  if (!state?.indicators?.loginTaxId || !state?.indicators?.loginPassword) {
    throw new Error(
      `Login fields unavailable; title=${state?.title || ""} url=${state?.url || ""}`
    );
  }

  log("STEP 2 enter credentials with human-like typing");
  const taxId = page.locator("#taxid").first();
  const passwordInput = page.locator("#password").first();

  await taxId.click();
  await taxId.pressSequentially(nif, { delay: 70 });
  await page.waitForTimeout(350);
  await passwordInput.click();
  await passwordInput.pressSequentially(password, { delay: 80 });
  await page.waitForTimeout(650);

  await snapshot("03-login-filled");

  log("STEP 3 click Login");
  const submit = page.locator('button[type="submit"]').first();
  if (!(await submit.count())) throw new Error("Login submit button not found");

  const dashboardResponsePromise = page
    .waitForResponse(
      (response) =>
        response.url().includes("/employee/dashboard") &&
        response.request().method() === "POST",
      { timeout: 15000 }
    )
    .catch(() => null);

  await submit.click();

  const dashboardResponse = await dashboardResponsePromise;
  log("Login POST observed", {
    status: dashboardResponse?.status() ?? null,
    url: dashboardResponse ? safeUrl(dashboardResponse.url()) : null,
  });

  const postLoginState = await waitForPostLoginState(25000);
  log("Post-login state resolved", { postLoginState });
  state = await snapshot("04-after-login");

  if (postLoginState !== "dashboard") {
    throw new Error(
      `Dashboard not reached; state=${postLoginState} title=${state?.title || ""} url=${state?.url || ""}`
    );
  }

  log("STEP 4 navigate to Workshift through dashboard link");
  const workshiftLink = page
    .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
    .first();

  if (!(await workshiftLink.count())) {
    throw new Error("Workshift link not found on dashboard");
  }

  await workshiftLink.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await workshiftLink.click();
  await page.waitForTimeout(1500);

  state = await snapshot("05-workshift");

  if (state?.title === "Just a moment..." || state?.indicators?.challengeText) {
    log("Challenge visible after Workshift click; waiting up to 20s for Scrapeless");
    await page.waitForTimeout(20000);
    state = await snapshot("06-workshift-after-solver-wait");
  }

  const today = madridDate();
  const container = page.locator(`#container_${today}`);
  const todayCount = await container.count();

  if (!todayCount) {
    throw new Error(
      `Today container not found for ${today}; title=${state?.title || ""} url=${state?.url || ""}`
    );
  }

  await container.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(350);

  const rows = container.locator("tr");
  const rowCount = await rows.count();
  const shiftRows = [];

  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const cells = row.locator("td.hr-container");
    const cellCount = await cells.count();
    if (cellCount < 2) continue;

    const values = [];
    for (let j = 0; j < Math.min(cellCount, 2); j += 1) {
      const cell = cells.nth(j);
      const input = cell.locator("input.clockpicker").first();
      const icon = cell.locator('i.fe-clock[data-original-title]').first();
      const button = cell.locator("a.clock").first();

      values.push({
        planned:
          (await input.count())
            ? await input.inputValue().catch(() => "")
            : "",
        factTitle:
          (await icon.count())
            ? await icon.getAttribute("data-original-title")
            : null,
        clockButtonExists: (await button.count()) > 0,
        clockButtonClass:
          (await button.count())
            ? await button.getAttribute("class")
            : null,
      });
    }

    shiftRows.push(values);
  }

  fs.writeFileSync(
    path.join(runDir, "workshift-readonly.json"),
    JSON.stringify({ today, rowCount, shiftRows }, null, 2)
  );

  log("READ-ONLY SUCCESS: Workshift and today's row reached", {
    today,
    rowCount,
    shiftRows,
  });

  const elapsedMs = Date.now() - startedAt;
  const summary = {
    success: true,
    clientId,
    provider: "scrapeless",
    sessionName,
    sessionTTL: 180,
    sessionRecording: true,
    proxyCountry: "ES",
    elapsedMs,
    elapsedBrowserMinutes: Number((elapsedMs / 60000).toFixed(3)),
    writeActionsPerformed: false,
    finalUrl: safeUrl(page.url()),
    finalTitle: await page.title().catch(() => ""),
    today,
    shiftRows,
  };

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("SCRAPELESS_SMOKE_RESULT " + JSON.stringify(summary));
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  const message = String(error?.stack || error?.message || error);
  log("SMOKE FAILURE", { error: message.slice(0, 3000) });
  await snapshot("99-failure").catch(() => {});

  const elapsedMs = Date.now() - startedAt;
  const sessionName = `bilky-${clientId}-${runId}`;

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        success: false,
        clientId,
        provider: "scrapeless",
        sessionName,
        sessionTTL: 180,
        sessionRecording: true,
        proxyCountry: "ES",
        elapsedMs,
        elapsedBrowserMinutes: Number((elapsedMs / 60000).toFixed(3)),
        writeActionsPerformed: false,
        error: String(error?.message || error),
        finalUrl: page ? safeUrl(page.url()) : null,
        finalTitle: page ? await page.title().catch(() => "") : null,
      },
      null,
      2
    )
  );
} finally {
  persist();
  if (browser) {
    await browser.close().catch(() => {});
  }
}

process.exit(exitCode);