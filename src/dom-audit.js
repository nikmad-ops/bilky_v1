import fs from "node:fs";
import { chromium } from "playwright-core";
import { AirtopClient } from "@airtop/sdk";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  AIRTOP_API_KEY,
  AIRTOP_PROFILE_NAME = "bilky-nik",
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  AIRTOP_API_KEY,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";

const outDir = "dom-audit";
fs.mkdirSync(outDir, { recursive: true });

const airtop = new AirtopClient({ apiKey: AIRTOP_API_KEY });
let sessionId;
let browser;
let page;

const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

async function snapshot(name) {
  const data = await page.evaluate(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      htmlLang: document.documentElement.lang || "",
      login: {
        taxid: Boolean(document.querySelector("#taxid")),
        password: Boolean(document.querySelector("#password")),
        submitVisible: Array.from(document.querySelectorAll('button[type="submit"]')).filter(visible).length,
      },
      dashboard: {
        workshiftLinks: Array.from(document.querySelectorAll('a[href*="/employee/hour-registration/hour-registration/show/"]')).filter(visible).length,
      },
      workshift: {
        containers: Array.from(document.querySelectorAll('[id^="container_"]')).map(x => x.id),
        hrCells: document.querySelectorAll("td.hr-container").length,
        clockpickers: Array.from(document.querySelectorAll("input.clockpicker")).map(x => x.value || ""),
        clockButtons: document.querySelectorAll("a.clock").length,
        clockFacts: Array.from(document.querySelectorAll('i.fe-clock[data-original-title]')).map(x => x.getAttribute("data-original-title")),
        signButtons: document.querySelectorAll("button#sign").length,
        successBadges: document.querySelectorAll(".badge-success").length,
      },
      challenge: {
        cloudflareMarkers: /cloudflare|cf-chl|challenge-platform|turnstile/i.test(
          (document.body?.innerText || "") + "\n" + document.documentElement.outerHTML
        ),
      },
    };
  });

  fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify(data, null, 2));

  const dom = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    for (const input of clone.querySelectorAll("input")) input.removeAttribute("value");
    for (const el of clone.querySelectorAll('[name*="password" i],[id*="password" i],[autocomplete="current-password"]')) {
      el.removeAttribute("value");
      el.textContent = "";
    }
    return "<!doctype html>\n" + clone.outerHTML;
  });
  fs.writeFileSync(`${outDir}/${name}.html`, dom);

  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false }).catch(() => {});
}

async function main() {
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
  browser = await chromium.connectOverCDP(session.data.cdpWsUrl, {
    headers: { authorization: `Bearer ${AIRTOP_API_KEY}` },
    timeout: 120000,
  });

  const context = browser.contexts()[0];
  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(28000);

  await page.goto(WORKSHIFT_URL, { waitUntil: "domcontentloaded", timeout: 28000 });
  await snapshot("01-initial");

  if (page.url().includes("/auth/login")) {
    await snapshot("02-login");

    await page.locator("#taxid").fill(BILKY_NIF);
    await page.locator("#password").fill(BILKY_PASSWORD);
    const submit = page.locator('button[type="submit"]').first();
    await submit.evaluate((el) => {
      const form = el.form;
      if (form && typeof form.requestSubmit === "function") form.requestSubmit(el);
      else el.click();
    });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const hasDashboard = await page.locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible').count();
      const hasWorkshift = await page.locator('[id^="container_"]').count();
      if (hasDashboard || hasWorkshift) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const hasDashboard = await page.locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible').count();
  const hasWorkshift = await page.locator('[id^="container_"]').count();

  if (hasDashboard) {
    await snapshot("03-dashboard");
    await page.locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible').first().evaluate(el => el.click());
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await page.locator('[id^="container_"]').count()) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  if (hasWorkshift || await page.locator('[id^="container_"]').count()) {
    await snapshot("04-workshift");
  } else {
    await snapshot("99-unresolved");
  }

  const summary = {
    sessionId,
    completedAt: new Date().toISOString(),
    files: fs.readdirSync(outDir).sort(),
  };
  fs.writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
}

main()
  .catch(async (error) => {
    fs.writeFileSync(`${outDir}/error.txt`, String(error?.stack || error));
    if (page) await snapshot("99-error").catch(() => {});
    throw error;
  })
  .finally(async () => {
    if (sessionId) {
      await fetch(`https://api.airtop.ai/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${AIRTOP_API_KEY}` },
      }).catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
  });
