import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";
import fs from "node:fs";

export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
export const TIMEZONE = "Europe/Madrid";

const AIRTOP_SESSION_BUDGET_MS = 28000;
const SCRAPELESS_SESSION_BUDGET_MS = 50000;
const POST_LOGIN_STATE_TIMEOUT_MS = 8000;
const FORENSIC_CAPTURE_BUDGET_MS = 3500;
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
  const facts = [
    ...String(body || "").matchAll(
      /data-original-title=["']\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})["']/g
    ),
  ].map((match) => match[1]);

  return {
    morning: facts[0] || null,
    evening: facts[1] || null,
    all: facts,
  };
}

export function createProductionClient({
  nif,
  password,
  airtopApiKey,
  scrapelessApiKey,
  browserlessToken,
  provider = "airtop",
  attempt,
  diagnosticsDir = "diagnostics",
}) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!["airtop", "scrapeless", "browserless"].includes(provider)) {
    throw new Error(`Unsupported browser provider: ${provider}`);
  }
  if (provider === "airtop" && !airtopApiKey) throw new Error("Missing AIRTOP_API_KEY");
  if (provider === "scrapeless" && !scrapelessApiKey) throw new Error("Missing SCRAPELESS_API_KEY");
  if (provider === "browserless" && !browserlessToken) throw new Error("Missing BROWSERLESS_TOKEN");
  if (![1, 2, 3, 4, 5].includes(Number(attempt))) {
    throw new Error(`ATTEMPT must be 1..5. Got: ${attempt}`);
  }

  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const airtop = provider === "airtop" ? new AirtopClient({ apiKey: airtopApiKey }) : null;

  let sessionId = null;
  let browser = null;
  let context = null;
  let page = null;
  let scrapelessCdp = null;
  const captchaEvents = [];
  const recentNetwork = [];

  function safeUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return "";
    }
  }
  let sessionReadyAt = 0;
  let sessionDeadline = 0;
  const scrapelessSolvedChallengeKeys = new Set();
  let scrapelessCaptchaWaiter = null;

  function sessionBudgetMs() {
    return provider === "scrapeless"
      ? SCRAPELESS_SESSION_BUDGET_MS
      : AIRTOP_SESSION_BUDGET_MS;
  }

  async function connect() {
    if (provider === "airtop") {
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
      sessionDeadline = sessionReadyAt + sessionBudgetMs();

      log(
        `Airtop session ready: ${sessionId}; budget=${sessionBudgetMs()}ms profile=${AIRTOP_PROFILE_NAME}`
      );

      try {
        await airtop.sessions.onCaptchaEvent(sessionId, (event) => {
          const status = event?.status || "unknown";
          const type = event?.type || "unknown";
          const duration = event?.duration ?? "n/a";
          const safeEvent = {
            at: new Date().toISOString(),
            status,
            type,
            durationMs:
              typeof event?.duration === "number" ? event.duration : null,
            solved: event?.solved === true,
          };
          captchaEvents.push(safeEvent);

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
    } else if (provider === "scrapeless") {
      const maxConnectAttempts = 3;
      let lastConnectError = null;

      for (let connectAttempt = 1; connectAttempt <= maxConnectAttempts; connectAttempt += 1) {
        const sessionName = `bilky-${process.env.CLIENT_ID || "client"}-${Date.now()}-c${connectAttempt}`;
        const params = new URLSearchParams({
          token: scrapelessApiKey,
          sessionTTL: "60",
          sessionName,
          sessionRecording: "true",
          proxyCountry: "ES",
        });

        log(
          `Creating Scrapeless session. attempt=${attempt}/5 connect=${connectAttempt}/${maxConnectAttempts} proxy=ES`
        );

        try {
          browser = await chromium.connectOverCDP(
            `wss://browser.scrapeless.com/api/v2/browser?${params.toString()}`,
            { timeout: 20000 }
          );

          sessionId = sessionName;
          sessionReadyAt = Date.now();
          sessionDeadline = sessionReadyAt + sessionBudgetMs();

          log(
            `Scrapeless session ready: ${sessionId}; budget=${sessionBudgetMs()}ms connect=${connectAttempt}/${maxConnectAttempts}`
          );
          lastConnectError = null;
          break;
        } catch (error) {
          lastConnectError = error;
          const message = String(error?.message || error).split("\n")[0].slice(0, 240);
          log(
            `Scrapeless connect failed: connect=${connectAttempt}/${maxConnectAttempts} message=${message}`
          );

          if (connectAttempt < maxConnectAttempts) {
            log("Scrapeless infrastructure reconnect in 5 seconds.");
            await sleep(5000);
          }
        }
      }

      if (!browser) {
        if (!browserlessToken) {
          throw lastConnectError || new Error("Scrapeless connection failed and Browserless fallback is unavailable");
        }

        log(
          "Scrapeless unavailable after 3 connection attempts; switching this Bilky attempt to Browserless fallback."
        );
        provider = "browserless";

        const region = String(process.env.BROWSERLESS_REGION || "ams").trim().toLowerCase();
        if (!["ams", "lon", "sfo"].includes(region)) {
          throw new Error(`Invalid BROWSERLESS_REGION: ${region}`);
        }

        const params = new URLSearchParams({
          token: browserlessToken,
          solveCaptchas: "true",
          timeout: "60000",
        });

        const profile = String(process.env.BROWSERLESS_PROFILE || "").trim();
        if (profile) params.set("profile", profile);

        const host = `production-${region}.browserless.io`;
        log(
          `Creating Browserless fallback session. attempt=${attempt}/5 region=${region} route=/stealth solveCaptchas=true`
        );

        browser = await chromium.connectOverCDP(
          `wss://${host}/stealth?${params.toString()}`,
          { timeout: 20000 }
        );

        sessionId = `browserless-${process.env.CLIENT_ID || "client"}-${Date.now()}`;
        sessionReadyAt = Date.now();
        sessionDeadline = sessionReadyAt + sessionBudgetMs();

        log(
          `Browserless fallback session ready: ${sessionId}; budget=${sessionBudgetMs()}ms`
        );
      }
    } else {
      const region = String(process.env.BROWSERLESS_REGION || "ams").trim().toLowerCase();
      if (!["ams", "lon", "sfo"].includes(region)) {
        throw new Error(`Invalid BROWSERLESS_REGION: ${region}`);
      }

      const params = new URLSearchParams({
        token: browserlessToken,
        solveCaptchas: "true",
        timeout: "60000",
      });

      const profile = String(process.env.BROWSERLESS_PROFILE || "").trim();
      if (profile) params.set("profile", profile);

      const host = `production-${region}.browserless.io`;
      log(`Creating Browserless session. attempt=${attempt}/5 region=${region} route=/stealth solveCaptchas=true`);

      browser = await chromium.connectOverCDP(
        `wss://${host}/stealth?${params.toString()}`,
        { timeout: 20000 }
      );

      sessionId = `browserless-${process.env.CLIENT_ID || "client"}-${Date.now()}`;
      sessionReadyAt = Date.now();
      sessionDeadline = sessionReadyAt + sessionBudgetMs();

      log(
        `Browserless session ready: ${sessionId}; budget=${sessionBudgetMs()}ms`
      );
    }

    context = browser.contexts()[0];
    if (!context) {
      throw new Error(`${provider} default browser context not found`);
    }

    page = context.pages()[0] || (await context.newPage());

    if (provider === "scrapeless") {
      scrapelessCdp = await context.newCDPSession(page);

      for (const eventName of [
        "Captcha.detected",
        "Captcha.solveFinished",
        "Captcha.solveFailed",
      ]) {
        scrapelessCdp.on(eventName, (event) => {
          const safeEvent = {
            at: new Date().toISOString(),
            provider: "scrapeless",
            event: eventName,
            type: event?.type || null,
            success: event?.success ?? null,
            message: event?.message || null,
          };
          captchaEvents.push(safeEvent);
          log(
            `Scrapeless ${eventName}: type=${safeEvent.type || "unknown"} success=${safeEvent.success ?? "n/a"} message=${safeEvent.message || "n/a"}`
          );

          if (
            scrapelessCaptchaWaiter &&
            (eventName === "Captcha.solveFinished" || eventName === "Captcha.solveFailed")
          ) {
            const waiter = scrapelessCaptchaWaiter;
            scrapelessCaptchaWaiter = null;
            waiter({
              event: eventName,
              success:
                eventName === "Captcha.solveFinished"
                  ? event?.success !== false
                  : false,
              message: event?.message || null,
              type: event?.type || null,
            });
          }
          fs.writeFileSync(
            `${diagnosticsDir}/captcha-events.json`,
            JSON.stringify(captchaEvents, null, 2),
            "utf8"
          );
        });
      }

      log("Scrapeless CAPTCHA lifecycle logging enabled.");
    }

    page.on("request", (request) => {
      recentNetwork.push({
        at: new Date().toISOString(),
        kind: "request",
        method: request.method(),
        resourceType: request.resourceType(),
        url: safeUrl(request.url()),
      });
      if (recentNetwork.length > 40) recentNetwork.splice(0, recentNetwork.length - 40);
    });

    page.on("response", (response) => {
      recentNetwork.push({
        at: new Date().toISOString(),
        kind: "response",
        status: response.status(),
        url: safeUrl(response.url()),
      });
      if (recentNetwork.length > 40) recentNetwork.splice(0, recentNetwork.length - 40);
    });

    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(sessionBudgetMs());
  }

  function remainingSessionMs() {
    if (!sessionDeadline) return sessionBudgetMs();
    return Math.max(0, sessionDeadline - Date.now());
  }

  async function pageHasScrapelessChallenge() {
    if (provider !== "scrapeless" || !page) return false;

    return page
      .evaluate(() => {
        const text = document.body?.innerText || "";
        const html = document.documentElement?.outerHTML || "";
        return (
          Boolean(
            document.querySelector(
              '[name="cf-turnstile-response"], iframe[src*="turnstile"], [id*="cf-chl"], [class*="cf-chl"], [data-cf-chl]'
            )
          ) ||
          /checking your browser|verify you are human|security verification|performing security verification|just a moment/i.test(
            document.title + " " + text
          )
        );
      })
      .catch(() => false);
  }

  async function detectKnownBilkyState(date) {
    if (!page) return null;
    if (await pageHasScrapelessChallenge()) return null;

    const container = page.locator(`#container_${date}`);
    if (await container.isVisible().catch(() => false)) {
      return "workshift";
    }

    const hasLoginFields =
      (await page.locator("#taxid").count().catch(() => 0)) > 0 &&
      (await page.locator("#password").count().catch(() => 0)) > 0;
    if (hasLoginFields) {
      return "login";
    }

    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
      .first();
    if ((await workshiftLink.count().catch(() => 0)) > 0) {
      return "dashboard";
    }

    return null;
  }

  async function handleScrapelessChallenge(stage, date) {
    if (provider !== "scrapeless" || !scrapelessCdp || !page) return false;
    if (!(await pageHasScrapelessChallenge())) return false;

    const key = `${stage}|${safeUrl(page.url())}`;
    if (scrapelessSolvedChallengeKeys.has(key)) {
      return true;
    }
    scrapelessSolvedChallengeKeys.add(key);

    const remaining = remainingSessionMs();
    if (remaining <= 1000) return true;

    log(
      `Scrapeless challenge detected at ${stage}; one managed solve; remaining=${remaining}ms`
    );

    const eventPromise = new Promise((resolve) => {
      scrapelessCaptchaWaiter = resolve;
    });

    scrapelessCdp
      .send("Captcha.solve", {
        detectTimeout: Math.max(1000, Math.min(12000, remaining - 1000)),
      })
      .then((result) => {
        log(
          `Scrapeless Captcha.solve command ${stage}: success=${result?.success ?? "n/a"} message=${result?.message || "n/a"} type=${result?.type || "unknown"}`
        );
      })
      .catch((error) => {
        log(
          `Scrapeless Captcha.solve command ${stage} warning: ${String(error?.message || error)
            .split("\n")[0]
            .slice(0, 200)}`
        );
      });

    const knownStatePromise = (async () => {
      while (remainingSessionMs() > 0) {
        const state = await detectKnownBilkyState(date);
        if (state) {
          return {
            source: "bilky-state",
            success: true,
            message: `challenge cleared; Bilky state=${state}`,
            type: null,
            state,
          };
        }
        await sleep(250);
      }

      return {
        source: "budget",
        success: false,
        message: "session budget reached",
        type: null,
      };
    })();

    const timeoutMs = Math.max(1, remainingSessionMs());
    const terminal = await Promise.race([
      eventPromise.then((result) => ({ source: "event", ...result })),
      knownStatePromise,
      sleep(timeoutMs).then(() => ({
        source: "budget",
        success: false,
        message: "session budget reached",
        type: null,
      })),
    ]);

    if (terminal.source !== "event" && scrapelessCaptchaWaiter) {
      scrapelessCaptchaWaiter = null;
    }

    log(
      `Scrapeless managed solve ${stage}: source=${terminal.source} success=${terminal.success ?? "n/a"} message=${terminal.message || "n/a"} type=${terminal.type || "unknown"}`
    );

    return true;
  }

  function assertSessionBudget(stage) {
    const remaining = remainingSessionMs();

    if (remaining <= 0) {
      throw new Error(
        `${provider} session budget exceeded at ${stage}: ${sessionBudgetMs()}ms`
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
                `${provider} session budget exceeded at ${stage}: ${sessionBudgetMs()}ms`
              )
            ),
          remaining
        );
      }),
    ]);
  }

  function isDashboardUrl(url = page?.url() || "") {
    return (
      url.includes("/employee/dashboard/") ||
      url.includes("/employee/control/panel")
    );
  }

  async function waitForState(date, timeoutMs = sessionBudgetMs()) {
    const container = page.locator(`#container_${date}`);
    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
      .first();

    const deadline = Math.min(Date.now() + timeoutMs, sessionDeadline || Infinity);

    while (Date.now() < deadline) {
      assertSessionBudget("waitForState");
      if (await container.isVisible().catch(() => false)) {
        return "workshift";
      }

      const hasLoginFields =
        (await page.locator("#taxid").count().catch(() => 0)) > 0 &&
        (await page.locator("#password").count().catch(() => 0)) > 0;

      if (hasLoginFields) {
        return "login";
      }

      if (await pageHasScrapelessChallenge()) {
        await handleScrapelessChallenge("waitForState", date);
        await sleep(250);
        continue;
      }

      const hasWorkshiftLink = (await workshiftLink.count().catch(() => 0)) > 0;
      if (hasWorkshiftLink) {
        return "dashboard";
      }

      await sleep(500);
    }

    throw new Error(`Bilky state unresolved after navigation; url=${page.url()}`);
  }

  async function captureForensic(reason, date) {
    if (!page) return;

    const startedAt = Date.now();
    const safe = async (operation, fallback = null) => {
      try {
        return await operation();
      } catch {
        return fallback;
      }
    };

    const url = safeUrl(page.url());

    const snapshot = await safe(
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
          const clone = document.documentElement.cloneNode(true);

          for (const input of clone.querySelectorAll("input")) {
            input.removeAttribute("value");
          }

          for (const el of clone.querySelectorAll(
            '[name*="password" i],[id*="password" i],[autocomplete="current-password"]'
          )) {
            el.removeAttribute("value");
            el.textContent = "";
          }

          return {
            title: document.title,
            readyState: document.readyState,
            fingerprint: {
              url: location.origin + location.pathname,
              title: document.title,
              readyState: document.readyState,
              hasLoginTaxId: Boolean(document.querySelector("#taxid")),
              hasLoginPassword: Boolean(document.querySelector("#password")),
              visibleSubmitButtons: Array.from(
                document.querySelectorAll('button[type="submit"]')
              ).filter(visible).length,
              workshiftLinks: document.querySelectorAll(
                'a[href*="/employee/hour-registration/hour-registration/show/"]'
              ).length,
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
              challengeIndicators: {
                challengeScript:
                  /\/cdn-cgi\/challenge-platform\//i.test(html),
                turnstile:
                  Boolean(
                    document.querySelector(
                      '[name="cf-turnstile-response"], iframe[src*="turnstile"]'
                    )
                  ),
                cfChallengeElement:
                  Boolean(
                    document.querySelector(
                      '[id*="cf-chl"], [class*="cf-chl"], [data-cf-chl]'
                    )
                  ),
                visibleChallengeText:
                  /checking your browser|verify you are human|security verification|performing security verification/i.test(
                    text
                  ),
              },
            },
            sanitizedDom: "<!doctype html>\n" + clone.outerHTML,
          };
        }, date),
      null
    );

    const payload = {
      capturedAt: new Date().toISOString(),
      reason,
      date,
      url,
      title: snapshot?.title || "",
      readyState: snapshot?.readyState || "unknown",
      captchaEvents,
      fingerprint: snapshot?.fingerprint || null,
      recentNetwork: recentNetwork.slice(-40),
    };

    fs.writeFileSync(
      `${diagnosticsDir}/forensic-${reason}.json`,
      JSON.stringify(payload, null, 2),
      "utf8"
    );

    if (snapshot?.sanitizedDom) {
      fs.writeFileSync(
        `${diagnosticsDir}/forensic-${reason}.html`,
        snapshot.sanitizedDom,
        "utf8"
      );
    }

    const remaining = Math.max(
      0,
      FORENSIC_CAPTURE_BUDGET_MS - (Date.now() - startedAt)
    );

    if (remaining >= 200) {
      await safe(
        async () => {
          await page.evaluate(() => {
            for (const el of document.querySelectorAll(
              '#taxid,#password,input[type="password"],[autocomplete="current-password"]'
            )) {
              const input = /** @type {HTMLInputElement} */ (el);
              if (!input.dataset.bilkyMaskOriginalType) {
                input.dataset.bilkyMaskOriginalType = input.getAttribute("type") || "text";
              }
              input.setAttribute("type", "password");
            }
          });

          try {
            await page.screenshot({
              path: `${diagnosticsDir}/forensic-${reason}.png`,
              fullPage: false,
              timeout: Math.min(1500, remaining),
            });
          } finally {
            await page.evaluate(() => {
              for (const el of document.querySelectorAll(
                '[data-bilky-mask-original-type]'
              )) {
                const input = /** @type {HTMLInputElement} */ (el);
                const original = input.dataset.bilkyMaskOriginalType || "text";
                input.setAttribute("type", original);
                delete input.dataset.bilkyMaskOriginalType;
              }
            }).catch(() => {});
          }
        },
        null
      );
    }

    log(
      `Forensic snapshot finished: reason=${reason} durationMs=${
        Date.now() - startedAt
      }`
    );
  }

  async function waitAfterLogin(
    date,
    timeoutMs = provider === "scrapeless"
      ? remainingSessionMs()
      : POST_LOGIN_STATE_TIMEOUT_MS
  ) {
    const container = page.locator(`#container_${date}`);
    const workshiftLink = page
      .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
      .first();

    const deadline = Math.min(Date.now() + timeoutMs, sessionDeadline || Infinity);

    while (Date.now() < deadline) {
      assertSessionBudget("waitAfterLogin");

      if (await container.isVisible().catch(() => false)) {
        return "workshift";
      }

      if (await pageHasScrapelessChallenge()) {
        await handleScrapelessChallenge("waitAfterLogin", date);
        await sleep(250);
        continue;
      }

      const hasWorkshiftLink = (await workshiftLink.count().catch(() => 0)) > 0;
      if (hasWorkshiftLink) {
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

  function isScrapelessProxyTunnelError(error) {
    const message = String(error?.message || error || "");
    return (
      message.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
      message.includes("ERR_PROXY_CONNECTION_FAILED")
    );
  }

  async function openWorkshiftWithInfrastructureRecovery(date) {
    const maxProxyAttempts = 3;

    for (let proxyAttempt = 1; proxyAttempt <= maxProxyAttempts; proxyAttempt += 1) {
      try {
        await openWorkshift(date);
        return;
      } catch (error) {
        if (provider !== "scrapeless" || !isScrapelessProxyTunnelError(error)) {
          throw error;
        }

        const message = String(error?.message || error).split("\n")[0].slice(0, 240);
        log(
          `Scrapeless proxy/tunnel failure: proxyAttempt=${proxyAttempt}/${maxProxyAttempts} message=${message}`
        );

        if (proxyAttempt < maxProxyAttempts) {
          log("Retrying with a fresh Scrapeless session in 5 seconds; business attempt is not consumed.");
          await close();
          provider = "scrapeless";
          await sleep(5000);
          await connect();
          continue;
        }

        if (!browserlessToken) {
          throw error;
        }

        log(
          "Scrapeless proxy/tunnel failed 3 fresh sessions; switching this Bilky attempt to Browserless fallback."
        );
        await close();
        provider = "browserless";
        await connect();
        await openWorkshift(date);
        return;
      }
    }
  }

  async function openWorkshift(date) {
    log(`Opening direct Workshift URL through ${provider}.`);

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
        .locator('a[href*="/employee/hour-registration/hour-registration/show/"]')
        .first();

      const href =
        (await link.getAttribute("href").catch(() => null)) || WORKSHIFT_URL;

      log(
        `Dashboard detected; opening Workshift by authenticated URL. href=${href}`
      );

      await withinSessionBudget(
        () =>
          page.goto(href, {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1000, remainingSessionMs()),
          }),
        "openWorkshift.dashboardGoto"
      );

      state = await waitForState(date);

      if (state === "login") {
        state = await loginIfNeeded(date);
      }

      if (state === "dashboard") {
        throw new Error("Bilky remained on dashboard after Workshift navigation");
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
      await openWorkshiftWithInfrastructureRecovery(date);
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
      await openWorkshiftWithInfrastructureRecovery(date);

      return await withinSessionBudget(async () => {
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
          provider,
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

      log(`CLICK ${mode}: authorized production click via ${provider}.`);

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
            provider,
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
          provider,
        };
      }, "execute");
    } catch (error) {
      const failure = {
        capturedAt: new Date().toISOString(),
        provider,
        attempt: Number(attempt),
        date,
        action: mode,
        sessionId,
        sessionReadyAt: sessionReadyAt || null,
        sessionAgeMs: sessionReadyAt ? Date.now() - sessionReadyAt : null,
        url: page ? safeUrl(page.url()) : "",
        message: String(error?.message || error || "Unknown error").slice(0, 1000),
        stack: String(error?.stack || "").slice(0, 8000),
      };

      fs.writeFileSync(
        `${diagnosticsDir}/error.json`,
        JSON.stringify(failure, null, 2),
        "utf8"
      );

      await captureForensic("failure", date).catch((forensicError) => {
        log(
          `Forensic capture warning: ${String(forensicError?.message || forensicError)
            .split("\n")[0]
            .slice(0, 200)}`
        );
      });

      throw error;
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

    if (provider === "airtop" && activeSessionId) {
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
      log(`${provider} active session duration: ${Date.now() - sessionReadyAt}ms`);
    }

    browser = null;
    context = null;
    page = null;
    scrapelessCdp = null;
    scrapelessCaptchaWaiter = null;
    sessionId = null;
    sessionReadyAt = 0;
    sessionDeadline = 0;
  }

  return {
    inspect,
    execute,
    close,
  };
}