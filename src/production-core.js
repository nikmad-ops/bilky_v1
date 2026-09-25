import { chromium } from "playwright-core";
import fs from "node:fs";

export const LOGIN_URL = "https://panel.bilky.es/auth/login";
export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
export const TIMEZONE = "Europe/Madrid";

const BROWSERLESS_ORIGIN = "https://production-ams.browserless.io";
const BROWSERLESS_WS = "wss://production-ams.browserless.io";
const DEFAULT_PROFILE = "bilky-nik-production";

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
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const total = end - start;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortError(error) {
  return String(error?.message || error || "Unknown error")
    .split("\n")[0]
    .slice(0, 300);
}

function factFromCell(value) {
  const text = String(value || "");

  const direct = text.match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );
  if (direct) return direct[1];

  const embedded = text.match(
    /data-original-title=["']\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})["']/i
  );
  return embedded ? embedded[1] : null;
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
  browserlessToken,
  attempt,
  profileName = DEFAULT_PROFILE,
  diagnosticsDir = "diagnostics",
}) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!browserlessToken) throw new Error("Missing BROWSERLESS_TOKEN");
  if (![1, 2, 3, 4, 5].includes(Number(attempt))) {
    throw new Error(`ATTEMPT must be 1..5. Got: ${attempt}`);
  }

  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const solverEnabled = Number(attempt) === 3;
  let browser = null;
  let page = null;
  let profileCreationConnection = false;
  let captchaSeen = false;

  function profileWs() {
    const params = new URLSearchParams({
      token: browserlessToken,
      profile: profileName,
    });
    if (solverEnabled) params.set("solveCaptchas", "true");
    return `${BROWSERLESS_WS}/stealth?${params.toString()}`;
  }

  async function createBlankProfile() {
    log(`Creating Browserless profile "${profileName}" once.`);

    const response = await fetch(
      `${BROWSERLESS_ORIGIN}/profile?token=${encodeURIComponent(browserlessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: profileName }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Browserless profile creation failed: HTTP ${response.status} ${await response.text()}`
      );
    }

    const session = await response.json();
    if (!session?.connect) {
      throw new Error("Browserless profile creation did not return connect URL");
    }

    const creationBrowser = await chromium.connectOverCDP(session.connect);
    try {
      const context = creationBrowser.contexts()[0];
      const creationPage = context.pages()[0] || (await context.newPage());
      const cdp = await context.newCDPSession(creationPage);
      await cdp.send("Browserless.saveProfile", { name: profileName });
    } finally {
      await creationBrowser.close().catch(() => {});
    }
  }

  async function connect() {
    try {
      browser = await chromium.connectOverCDP(profileWs());
    } catch (error) {
      const message = shortError(error);
      log(`Profile connection failed: ${message}`);
      await createBlankProfile();
      browser = await chromium.connectOverCDP(profileWs());
      profileCreationConnection = true;
    }

    const context = browser.contexts()[0];
    if (!context) throw new Error("Browserless default context is unavailable");

    page = context.pages()[0] || (await context.newPage());

    try {
      const cdp = await context.newCDPSession(page);
      cdp.on("Browserless.captchaFound", () => {
        captchaSeen = true;
        log("Cloudflare/CAPTCHA detected by Browserless.");
      });
      cdp.on("Browserless.captchaAutoSolved", (event) => {
        if (event?.solved) captchaSeen = false;
        log(`Browserless solver event solved=${Boolean(event?.solved)}`);
      });
    } catch (error) {
      log(`CAPTCHA event listener unavailable: ${shortError(error)}`);
    }
  }

  async function challengeDetected() {
    if (captchaSeen) return true;

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

  async function guardChallenge(stage, maxWaitMs = 45000) {
    const challenge = await challengeDetected();
    if (!challenge) return;

    if (!solverEnabled) {
      throw new Error(`CLOUDFLARE_CHALLENGE at ${stage}`);
    }

    log(`Attempt 3: solver handling challenge at ${stage}; no extra navigation.`);
    const deadline = Date.now() + maxWaitMs;
    let clearSince = 0;

    while (Date.now() < deadline) {
      const stillBlocked = await challengeDetected();

      if (stillBlocked) {
        clearSince = 0;
      } else {
        if (!clearSince) clearSince = Date.now();
        if (Date.now() - clearSince >= 1200) {
          captchaSeen = false;
          log(`Attempt 3: challenge cleared at ${stage}.`);
          return;
        }
      }

      await sleep(400);
    }

    throw new Error(`CAPTCHA_SOLVER_TIMEOUT at ${stage}`);
  }

  async function gotoAndGuard(url, stage) {
    captchaSeen = false;

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: solverEnabled ? 45000 : 20000,
      });
    } catch (error) {
      if (await challengeDetected()) {
        await guardChallenge(stage);
        return;
      }
      throw error;
    }

    await guardChallenge(stage);
  }

  async function saveProfileAfterLogin() {
    const context = page.context();
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send("Browserless.saveProfile", { name: profileName });
    log(
      `Browserless profile saved after login: cookies=${result?.cookieCount ?? "unknown"} origins=${result?.originCount ?? "unknown"}`
    );
  }

  async function loginOnlyIfBilkyAsks() {
    if (!page.url().includes("/auth/login")) return false;

    log("Bilky redirected to login; authenticating because cookies are not sufficient.");

    const inputs = page.locator("input:visible");
    if ((await inputs.count()) < 2) {
      throw new Error("Bilky login fields not found");
    }

    await inputs.nth(0).fill(nif);
    await page.locator('input[type="password"]').first().fill(password);

    const submit = page.locator('button[type="submit"]').first();
    if (!(await submit.count())) throw new Error("Bilky login button not found");

    captchaSeen = false;
    await submit.click();

    const deadline = Date.now() + (solverEnabled ? 60000 : 20000);
    while (Date.now() < deadline) {
      await guardChallenge("login");

      if (!page.url().includes("/auth/login")) {
        await saveProfileAfterLogin();
        return true;
      }

      await sleep(350);
    }

    throw new Error("Bilky login did not complete");
  }

  async function openWorkshift() {
    log("Opening direct Workshift URL first, matching restart UX.");
    await gotoAndGuard(WORKSHIFT_URL, "direct-workshift");

    const loggedInNow = await loginOnlyIfBilkyAsks();

    if (loggedInNow) {
      const container = page.locator(`#container_${madridDate()}`);
      if (await container.isVisible().catch(() => false)) {
        return;
      }

      const link = page
        .locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible')
        .first();

      if (!(await link.count())) {
        throw new Error("Workshift link not found on Bilky dashboard after login");
      }

      captchaSeen = false;
      try {
        await link.click({ noWaitAfter: true });
      } catch (error) {
        if (!(await challengeDetected())) throw error;
      }
      await guardChallenge("dashboard-workshift");
    }

    const container = page.locator(`#container_${madridDate()}`);
    const deadline = Date.now() + (solverEnabled ? 45000 : 15000);

    while (Date.now() < deadline) {
      await guardChallenge("workshift-ready");

      if (await container.isVisible().catch(() => false)) {
        log("Workshift ready.");
        return;
      }

      await sleep(300);
    }

    throw new Error("Bilky Workshift did not become ready");
  }

  async function targetCell(mode, date) {
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

    return { cell: cells.nth(index), cells };
  }

  async function existingFact(cell) {
    const icon = cell.locator('i.fe-clock[data-original-title]').first();
    if (!(await icon.count())) return null;

    const raw = await icon.getAttribute("data-original-title");
    return factFromCell(raw);
  }

  async function execute(mode, date) {
    await connect();

    log(
      `Attempt ${attempt}/5; Browserless profile=${profileName}; solver=${solverEnabled ? "ON" : "OFF"}`
    );

    await openWorkshift();

    const { cell, cells } = await targetCell(mode, date);
    const alreadyFact = await existingFact(cell);

    if (alreadyFact) {
      let morningFact = mode === "morning" ? alreadyFact : await existingFact(cells.nth(0));

      return {
        success: true,
        status: "already_done",
        action: mode,
        fact: alreadyFact,
        morningFact,
        eveningFact: mode === "evening" ? alreadyFact : null,
        duration: mode === "evening" ? dayDuration(morningFact, alreadyFact) : null,
        httpStatus: null,
        attempt: Number(attempt),
        solverUsed: solverEnabled,
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

    log(`CLICK ${mode}: executing authorized production click.`);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/employee/hour-registration/clock-hour") &&
        response.request().method() === "POST",
      { timeout: 15000 }
    );

    await button.click();
    const response = await responsePromise;

    log(`clock-hour HTTP ${response.status()}`);

    if (response.status() !== 200) {
      throw new Error(`Bilky clock-hour returned HTTP ${response.status()}`);
    }

    const body = await response.text();

    fs.writeFileSync(
      `${diagnosticsDir}/clock-${mode}-http-200-body.html`,
      body,
      "utf8"
    );

    fs.writeFileSync(
      "run-committed.json",
      JSON.stringify(
        {
          date,
          action: mode,
          httpStatus: 200,
          attempt: Number(attempt),
          committedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );

    const facts = factsFromHttp200(body);
    const fact = mode === "morning" ? facts.morning : facts.evening;

    return {
      success: true,
      status: "clicked",
      action: mode,
      fact,
      morningFact: facts.morning,
      eveningFact: facts.evening,
      duration: mode === "evening" ? dayDuration(facts.morning, facts.evening) : null,
      httpStatus: 200,
      factParseError: !fact,
      responseTimesFound: facts.all.length,
      attempt: Number(attempt),
      solverUsed: solverEnabled,
    };
  }

  async function close() {
    if (!browser) return;
    await browser.close().catch(() => {});
    browser = null;
  }

  return {
    execute,
    close,
    solverEnabled,
    profileCreationConnection: () => profileCreationConnection,
  };
}
