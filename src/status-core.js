import fs from "node:fs";
import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";

export const TIMEZONE = "Europe/Madrid";

const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";

const AIRTOP_STATUS_BUDGET_MS = 28000;
const AIRTOP_PROFILE_NAME = process.env.AIRTOP_PROFILE_NAME || "bilky-nik";

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

      const deadline = Date.now() + 8000;
      const link = page
        .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
        .first();

      while (Date.now() < deadline) {
        const hasDashboardUrl =
          page.url().includes("/employee/dashboard/") ||
          page.url().includes("/employee/control/panel");
        const hasDashboardLink = (await link.count()) > 0;
        const hasWorkshift = (await page.locator('[id^="container_"]').count()) > 0;

        if (hasDashboardUrl || hasDashboardLink || hasWorkshift) break;
        await sleep(250);
      }

      if (page.url().includes("/auth/login")) {
        throw new Error("Bilky status login did not complete");
      }

      const hasWorkshift = (await page.locator('[id^="container_"]').count()) > 0;
      if (!hasWorkshift && (await link.count())) {
        const href =
          (await link.getAttribute("href").catch(() => null)) || WORKSHIFT_URL;
        log("STATUS_STAGE=dashboard-workshift");
        await page.goto(href, {
          waitUntil: "domcontentloaded",
          timeout: 12000,
        });
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

    const rows = container.locator("tr");
    const rowCount = await rows.count();
    let row = null;
    const candidates = [];

    for (let i = 0; i < rowCount; i += 1) {
      const candidate = rows.nth(i);
      const candidateCells = candidate.locator("td.hr-container");
      if ((await candidateCells.count()) < 2) continue;

      const plans = [];
      for (let j = 0; j < 2; j += 1) {
        const cell = candidateCells.nth(j);
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
        row = candidate;
        break;
      }

      candidates.push(candidate);
    }

    if (!row && candidates.length === 1) row = candidates[0];
    if (!row) {
      throw new Error(
        `Shift row not found structurally for ${date}; candidates=${candidates.length}`
      );
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

    const signedBadgeCount = await container.locator(".badge-success").count();
    const signButtonCount = await container.locator("button#sign").count();
    const signed = signedBadgeCount > 0 && signButtonCount === 0;

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
          timeoutMinutes: 1,
          profileName: AIRTOP_PROFILE_NAME,
          persistProfile: true,
        },
      });

      sessionId = session.data.id;
      if (!session.data.cdpWsUrl) throw new Error("Airtop status session missing cdpWsUrl");

      const sessionReadyAt = Date.now();
      const sessionDeadline = sessionReadyAt + AIRTOP_STATUS_BUDGET_MS;

      log(
        `Airtop status session ready: ${sessionId}; budget=${AIRTOP_STATUS_BUDGET_MS}ms profile=${AIRTOP_PROFILE_NAME}`
      );

      try {
        await airtop.sessions.onCaptchaEvent(sessionId, (event) => {
          const safeEvent = {
            at: new Date().toISOString(),
            status: event?.status || "unknown",
            type: event?.type || "unknown",
            durationMs:
              typeof event?.duration === "number" ? event.duration : null,
            solved: event?.solved === true,
          };
          captchaEvents.push(safeEvent);
          log(
            `STATUS CAPTCHA: status=${safeEvent.status} type=${safeEvent.type} durationMs=${safeEvent.durationMs ?? "n/a"}`
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
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(AIRTOP_STATUS_BUDGET_MS);

      const result = await Promise.race([
        (async () => {
          await openWorkshift(page);
          const setStage = (stage) => log(`STATUS_STAGE=${stage}`);
          return operation({ page, setStage });
        })(),
        new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `Airtop status session budget exceeded: ${AIRTOP_STATUS_BUDGET_MS}ms`
                )
              ),
            Math.max(0, sessionDeadline - Date.now())
          );
        }),
      ]);

      if (captchaEvents.length) {
        fs.writeFileSync(
          `${diagnosticsDir}/status-captcha-events.json`,
          JSON.stringify(captchaEvents, null, 2),
          "utf8"
        );
      }

      return result;
    } finally {
      const activeSessionId = sessionId;

      if (activeSessionId) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        try {
          const response = await fetch(
            `https://api.airtop.ai/api/v1/sessions/${encodeURIComponent(activeSessionId)}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${airtopApiKey}`,
              },
              signal: controller.signal,
            }
          );

          if (response.status === 204) {
            log(`Airtop status session terminated explicitly: ${activeSessionId}`);
          } else {
            log(`Airtop status terminate HTTP ${response.status}`);
          }
        } catch (error) {
          log(
            `Airtop status terminate warning: ${String(error?.message || error)
              .split("\n")[0]
              .slice(0, 180)}`
          );
        } finally {
          clearTimeout(timeout);
        }
      }

      if (browser) await browser.close().catch(() => {});
    }
  }

  return { readDayState, run };
}
