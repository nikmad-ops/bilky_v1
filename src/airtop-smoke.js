import fs from "node:fs";
import { AirtopClient } from "@airtop/sdk";
import { chromium } from "playwright-core";

const LOGIN_URL = "https://panel.bilky.es/auth/login";

const {
  AIRTOP_API_KEY,
  BILKY_NIF,
  BILKY_PASSWORD,
} = process.env;

for (const [name, value] of Object.entries({
  AIRTOP_API_KEY,
  BILKY_NIF,
  BILKY_PASSWORD,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

const airtop = new AirtopClient({ apiKey: AIRTOP_API_KEY });

let sessionId = null;
let browser = null;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
  fs.rmSync("airtop-smoke-result.json", { force: true });

  try {
    log("Creating Airtop session: solveCaptcha=true, proxy=ES, sticky=true");

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

    browser = await chromium.connectOverCDP(session.data.cdpWsUrl, {
      headers: {
        authorization: `Bearer ${AIRTOP_API_KEY}`,
      },
      timeout: 120000,
    });

    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Airtop default browser context not found");
    }

    const page = context.pages()[0] || (await context.newPage());

    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    log("Opening Bilky login page");
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    log(`Initial URL: ${page.url()}`);
    log("Waiting for Bilky login fields (Airtop may solve Cloudflare first)");

    const field1 = page.locator("#taxid");
    const field2 = page.locator("#password");

    await field1.waitFor({ state: "visible", timeout: 120000 });
    await field2.waitFor({ state: "visible", timeout: 120000 });

    log(`Bilky login form reached. URL: ${page.url()}`);

    await field1.fill(BILKY_NIF);
    const field1Length = (await field1.inputValue()).length;
    const field1Ok = field1Length === BILKY_NIF.length;

    log(`FIELD_1_OK=${field1Ok} length=${field1Length}`);

    await field2.fill(BILKY_PASSWORD);
    const field2Length = (await field2.inputValue()).length;
    const field2Ok = field2Length === BILKY_PASSWORD.length;

    log(`FIELD_2_OK=${field2Ok} length=${field2Length}`);

    if (!field1Ok || !field2Ok) {
      throw new Error(
        `Bilky form fill verification failed: field1=${field1Ok} field2=${field2Ok}`
      );
    }

    const result = {
      success: true,
      provider: "airtop",
      solveCaptcha: true,
      proxyCountry: "ES",
      field1Ok,
      field2Ok,
      finalUrl: page.url(),
      loginClicked: false,
      workshiftClicked: false,
      finishedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      "airtop-smoke-result.json",
      JSON.stringify(result, null, 2),
      "utf8"
    );

    log("SAFE TEST COMPLETE. Login was NOT clicked. Workshift was NOT clicked.");
  } finally {
    if (browser) {
      log("Closing Airtop browser connection");
      await browser.close().catch((error) => {
        console.error(
          `Airtop browser close warning: ${String(error?.message || error)}`
        );
      });
      browser = null;
    }

    // Do not call airtop.sessions.terminate() here.
    // In the current SDK it can hang after Browser.close().
    // The Airtop session itself is configured with timeoutMinutes: 2,
    // so server-side cleanup remains bounded even if Browser.close() is not enough.
    if (sessionId) {
      log(`Airtop session cleanup bounded by timeoutMinutes=2: ${sessionId}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
