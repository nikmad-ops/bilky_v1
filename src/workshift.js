import { chromium } from "playwright-core";
import fs from "node:fs";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TARGET_DATE,
  ACTION,
} = process.env;

const LOGIN_URL = "https://panel.bilky.es/auth/login";
const TIMEZONE = "Europe/Madrid";

const required = {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ACTION,
};

for (const [name, value] of Object.entries(required)) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

if (!["morning", "evening"].includes(ACTION)) {
  throw new Error(`ACTION must be morning or evening. Got: ${ACTION}`);
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

function getMadridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const value = (type) =>
    parts.find((part) => part.type === type)?.value;

  return `${value("year")}-${value("month")}-${value("day")}`;
}

const targetDate = TARGET_DATE || getMadridDate();

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function sendTelegram(message) {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });

    if (!response.ok) {
      console.error(
        `Telegram failed: ${response.status()} ${await response.text()}`
      );
    }
  } catch (error) {
    console.error("Telegram exception:", error.message);
  }
}

function extractTime(text) {
  const match = String(text || "").match(/\b\d{2}:\d{2}\b/);
  return match ? match[0] : null;
}

function extractFactTime(value) {
  if (!value) return null;

  const match = value.match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );

  return match ? match[1] : null;
}

// ---------------------------------------------------------
// Read one side of shift: morning / evening
// ---------------------------------------------------------

async function readShiftCell(cell) {
  // PLAN:
  // Before clock Bilky renders an <input value="08:00">.
  // After clock Bilky renders <span>08:00</span>.
  // Therefore plan must be read independently from fact.

  let planned = null;

  const input = cell.locator("input.clockpicker").first();

  if (await input.count()) {
    planned = await input.inputValue();
  } else {
    const text = await cell.innerText();
    planned = extractTime(text);
  }

  // FACT:
  // Example:
  // data-original-title="26/08/2026 13:25:12"

  let fact = null;
  let factRaw = null;

  const factIcon = cell
    .locator('i.fe-clock[data-original-title]')
    .first();

  if (await factIcon.count()) {
    factRaw =
      await factIcon.getAttribute("data-original-title");

    fact = extractFactTime(factRaw);
  }

  // CLOCK BUTTON
  const clockButton = cell.locator("a.clock").first();

  const buttonExists = (await clockButton.count()) > 0;

  let buttonEnabled = false;
  let buttonId = null;

  if (buttonExists) {
    const className =
      (await clockButton.getAttribute("class")) || "";

    buttonEnabled =
      !className.split(/\s+/).includes("disabled");

    buttonId =
      await clockButton.getAttribute("id");
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

// ---------------------------------------------------------
// Read complete day state
// ---------------------------------------------------------

async function readDayState(page, date) {
  const containerSelector = `#container_${date}`;
  const container = page.locator(containerSelector);

  await container.waitFor({
    state: "visible",
    timeout: 15000,
  });

  const row = container
    .locator("tr")
    .filter({ hasText: "First shift" })
    .first();

  if (!(await row.count())) {
    throw new Error(`First shift row not found for ${date}`);
  }

  const shiftCells = row.locator("td.hr-container");

  if ((await shiftCells.count()) < 2) {
    throw new Error(
      `Expected morning and evening cells for ${date}`
    );
  }

  const morning = await readShiftCell(
    shiftCells.nth(0)
  );

  const evening = await readShiftCell(
    shiftCells.nth(1)
  );

  // SIGNED is authoritative only when Bilky actually
  // renders its success badge.
  const signedBadge = container
    .locator(".badge-success")
    .filter({ hasText: "Signed" });

  const signed = (await signedBadge.count()) > 0;

  // Sign button presence is NOT a state indicator.
  // We merely record whether it is available.
  const signButton = container.locator("button#sign");
  const signAvailable = (await signButton.count()) > 0;

  const text = await container.innerText();

  const pendingSignature =
    text.toLowerCase().includes("pending signature");

  return {
    containerSelector,
    morning,
    evening,
    signed,
    signAvailable,
    pendingSignature,
  };
}

function printState(state) {
  log("----- DAY STATE -----");

  log(
    `Morning: plan=${state.morning.planned ?? "NONE"} ` +
    `fact=${state.morning.fact ?? "NONE"} ` +
    `button=${state.morning.buttonExists ? "YES" : "NO"} ` +
    `enabled=${state.morning.buttonEnabled}`
  );

  log(
    `Evening: plan=${state.evening.planned ?? "NONE"} ` +
    `fact=${state.evening.fact ?? "NONE"} ` +
    `button=${state.evening.buttonExists ? "YES" : "NO"} ` +
    `enabled=${state.evening.buttonEnabled}`
  );

  log(
    `Signed=${state.signed} ` +
    `SignAvailable=${state.signAvailable} ` +
    `PendingSignature=${state.pendingSignature}`
  );

  log("---------------------");
}

// ---------------------------------------------------------
// Bilky navigation
// ---------------------------------------------------------

async function loginAndOpenWorkshift(page) {
  log("Opening Bilky login.");

  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const visibleInputs = page.locator("input:visible");

  if ((await visibleInputs.count()) < 2) {
    throw new Error("Bilky login fields not found");
  }

  const passwordInput =
    page.locator('input[type="password"]').first();

  await visibleInputs.nth(0).fill(BILKY_NIF);
  await passwordInput.fill(BILKY_PASSWORD);

  const submit =
    page.locator('button[type="submit"]').first();

  if (!(await submit.count())) {
    throw new Error("Bilky login button not found");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    submit.click(),
  ]);

  await page.waitForTimeout(1200);

  if (page.url().includes("/auth/login")) {
    throw new Error("Bilky login failed");
  }

  log("Login OK.");

  const workshiftLink = page
    .getByText("Workshift control", {
      exact: true,
    })
    .first();

  await workshiftLink.waitFor({
    state: "visible",
    timeout: 15000,
  });

  await workshiftLink.click();

  await page.waitForLoadState(
    "domcontentloaded"
  );

  await page.waitForTimeout(1200);

  log(`Workshift opened: ${page.url()}`);
}

// ---------------------------------------------------------
// Clock operation
// ---------------------------------------------------------

async function clock(page, state, mode) {
  const side =
    mode === "morning"
      ? state.morning
      : state.evening;

  const expectedPlan =
    mode === "morning"
      ? "08:00"
      : "16:00";

  if (side.planned !== expectedPlan) {
    throw new Error(
      `${mode}: unexpected planned time ` +
      `${side.planned}; expected ${expectedPlan}`
    );
  }

  if (side.fact) {
    log(
      `${mode}: already clocked at ${side.fact}. ` +
      `No duplicate click.`
    );

    return {
      alreadyDone: true,
      fact: side.fact,
    };
  }

  if (!side.buttonExists) {
    throw new Error(
      `${mode}: Clock in/out button does not exist`
    );
  }

  if (!side.buttonEnabled) {
    throw new Error(
      `${mode}: Clock in/out button is disabled`
    );
  }

  // Evening is not allowed unless morning fact exists.
  if (
    mode === "evening" &&
    !state.morning.fact
  ) {
    throw new Error(
      "Evening blocked because morning fact is missing"
    );
  }

  const container =
    page.locator(state.containerSelector);

  const row = container
    .locator("tr")
    .filter({ hasText: "First shift" })
    .first();

  const cells = row.locator("td.hr-container");

  const cell =
    mode === "morning"
      ? cells.nth(0)
      : cells.nth(1);

  const button = cell.locator("a.clock").first();

  log(
    `CLICK ${mode}: ${side.buttonId}`
  );

  // Bilky itself sends this POST via jQuery.
  const responsePromise =
    page.waitForResponse(
      (response) =>
        response.url().includes(
          "/employee/hour-registration/clock-hour"
        ) &&
        response.request().method() === "POST",
      {
        timeout: 20000,
      }
    );

  await button.click();

  const response =
    await responsePromise;

  log(
    `clock-hour HTTP ${response.status()}`
  );

  if (!response.ok()) {
    throw new Error(
      `Bilky clock-hour returned HTTP ${response.status()}`
    );
  }

  // The HTTP response is NOT our success criterion.
  // Reload and read authoritative Bilky state.
  await page.waitForTimeout(1200);

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(1200);

  const newState =
    await readDayState(page, targetDate);

  printState(newState);

  const newSide =
    mode === "morning"
      ? newState.morning
      : newState.evening;

  if (!newSide.fact) {
    throw new Error(
      `${mode}: POST succeeded but factual timestamp ` +
      `was not found after reload`
    );
  }

  log(
    `${mode}: FACT CONFIRMED ${newSide.fact}`
  );

  return {
    alreadyDone: false,
    fact: newSide.fact,
    state: newState,
  };
}

// ---------------------------------------------------------
// Sign
// ---------------------------------------------------------

async function signDay(page) {
  let state =
    await readDayState(page, targetDate);

  // Critical safety rule:
  // never sign until evening factual time exists.
  if (!state.evening.fact) {
    throw new Error(
      "Refusing to sign: evening fact is missing"
    );
  }

  if (state.signed) {
    log("Day already SIGNED.");
    return true;
  }

  if (!state.signAvailable) {
    throw new Error(
      "Evening completed but Sign button is unavailable"
    );
  }

  const container =
    page.locator(state.containerSelector);

  const signButton =
    container.locator("button#sign");

  log("Clicking Sign.");

  await signButton.click();

  // Bilky uses SweetAlert confirmation.
  const confirmButton =
    page.locator(
      ".sweet-alert:visible button.confirm"
    );

  await confirmButton.waitFor({
    state: "visible",
    timeout: 10000,
  });

  const responsePromise =
    page.waitForResponse(
      (response) =>
        response.url().includes(
          "/employee/hour-registration/update-registration"
        ) &&
        response.request().method() === "POST",
      {
        timeout: 20000,
      }
    );

  log("Confirming Sign.");

  await confirmButton.click();

  const response =
    await responsePromise;

  log(
    `update-registration HTTP ${response.status()}`
  );

  if (!response.ok()) {
    throw new Error(
      `Bilky Sign returned HTTP ${response.status()}`
    );
  }

  // Again, HTTP 200 isn't enough.
  await page.waitForTimeout(1200);

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(1200);

  state =
    await readDayState(page, targetDate);

  printState(state);

  if (!state.signed) {
    throw new Error(
      "Sign POST succeeded but SIGNED status " +
      "was not confirmed after reload"
    );
  }

  log("SIGNED CONFIRMED.");

  return true;
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

async function main() {
  fs.mkdirSync("diagnostics", {
    recursive: true,
  });

  log(`TARGET_DATE=${targetDate}`);
  log(`ACTION=${ACTION}`);

  const browser =
    await chromium.connectOverCDP(
      `wss://production-ams.browserless.io/stealth` +
      `?token=${BROWSERLESS_TOKEN}`
    );

  const contexts = browser.contexts();

  const context =
    contexts[0] ||
    (await browser.newContext());

  const pages = context.pages();

  const page =
    pages[0] ||
    (await context.newPage());

  try {
    await loginAndOpenWorkshift(page);

    let state =
      await readDayState(
        page,
        targetDate
      );

    printState(state);

    // -----------------------------------------------------
    // MORNING
    // -----------------------------------------------------

    if (ACTION === "morning") {
      const result =
        await clock(
          page,
          state,
          "morning"
        );

      await sendTelegram(
        [
          result.alreadyDone
            ? "ℹ️ Bilky morning already registered"
            : "✅ Bilky morning registered",
          `Date: ${targetDate}`,
          `Plan: 08:00`,
          `Fact: ${result.fact}`,
        ].join("\n")
      );

      log("MORNING SUCCESS");
      return;
    }

    // -----------------------------------------------------
    // EVENING
    // -----------------------------------------------------

    const result =
      await clock(
        page,
        state,
        "evening"
      );

    // Very important:
    // Sign only AFTER fact_end has been confirmed.
    const signed =
      await signDay(page);

    await sendTelegram(
      [
        result.alreadyDone
          ? "ℹ️ Bilky evening already registered"
          : "✅ Bilky evening registered",
        `Date: ${targetDate}`,
        `Plan: 16:00`,
        `Fact: ${result.fact}`,
        `Signed: ${signed ? "YES" : "NO"}`,
      ].join("\n")
    );

    log("EVENING SUCCESS");
  } catch (error) {
    console.error(
      `FAILED: ${error.message}`
    );

    try {
      await page.screenshot({
        path:
          "diagnostics/workshift-error.png",
        fullPage: true,
      });
    } catch {
      // Ignore screenshot failure
    }

    await sendTelegram(
      [
        "❌ Bilky automation FAILED",
        `Date: ${targetDate}`,
        `Action: ${ACTION}`,
        `Error: ${error.message}`,
      ].join("\n")
    );

    throw error;
  } finally {
    await browser.close();
  }
}

await main();
