import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";
import fs from "node:fs";

export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
export const TIMEZONE = "Europe/Madrid";

const AIRTOP_SESSION_BUDGET_MS = 28000;
const SCRAPELESS_SESSION_BUDGET_MS = 28000;
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
  provider = "airtop",
  dryRun = false,
  attempt,
  diagnosticsDir = "diagnostics",
}) {
  if (!nif) throw new Error("Missing BILKY_NIF");
  if (!password) throw new Error("Missing BILKY_PASSWORD");
  if (!["airtop", "scrapeless"].includes(provider)) {
    throw new Error(`Unsupported browser provider: ${provider}`);
  }
  if (provider === "airtop" && !airtopApiKey) throw new Error("Missing AIRTOP_API_KEY");
  if (provider === "scrapeless" && !scrapelessApiKey) throw new Error("Missing SCRAPELESS_API_KEY");
  if (![1, 2, 3, 4, 5].includes(Number(attempt))) {
    throw new Error(`ATTEMPT must be 1..5. Got: ${attempt}`);
  }

  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const airtop = provider === "airtop" ? new AirtopClient({ apiKey: airtopApiKey }) : null;

  let sessionId = null;
  let browser = null;
  let context = null;
  let page = null;
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

  async function connect() {
    let cdpWsUrl = "";
    let connectOptions = {};

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

      cdpWsUrl = session.data.cdpWsUrl;
      connectOptions = {
        headers: {
          authorization: `Bearer ${airtopApiKey}`,
        },
        timeout: 120000,
      };

      sessionReadyAt = Date.now();
      sessionDeadline = sessionReadyAt + AIRTOP_SESSION_BUDGET_MS;

      log(
        `Airtop session ready: ${sessionId}; budget=${provider === "scrapeless" ? SCRAPELESS_SESSION_BUDGET_MS : AIRTOP_SESSION_BUDGET_MS}ms profile=${AIRTOP_PROFILE_NAME}`
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
    } else {
      const sessionName = `bilky-${process.env.CLIENT_ID || "client"}-${Date.now()}`;
      const params = new URLSearchParams({
        token: scrapelessApiKey,
        sessionTTL: "60",
        sessionName,
        sessionRecording: "true",
        proxyCountry: "ES",
      });

      cdpWsUrl = `wss://browser.scrapeless.com/api/v2/browser?${params.toString()}`;
      connectOptions = { timeout: 20000 };

      sessionReadyAt = Date.now();
      sessionDeadline = sessionReadyAt + SCRAPELESS_SESSION_BUDGET_MS;
      sessionId = sessionName;

      log(
        `Creating Scrapeless session. attempt=${attempt}/5 proxy=ES recording=true budget=${SCRAPELESS_SESSION_BUDGET_MS}ms`
      );
    }

    browser = await chromium.connectOverCDP(cdpWsUrl, connectOptions);

    context = browser.contexts()[0];
    if (!context) {
      throw new Error(`${provider} default browser context not found`);
    }

    page = context.pages()[0] || (await context.newPage());

    page.on("request", (request) => {