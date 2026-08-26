import { chromium } from "playwright-core";
import fs from "node:fs";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN
} = process.env;

if (!BILKY_NIF || !BILKY_PASSWORD || !BROWSERLESS_TOKEN) {
  throw new Error("Missing required environment variables");
}

const LOGIN_URL = "https://panel.bilky.es/auth/login";

function sanitizeHtml(html) {
  return html
    .replaceAll(BILKY_NIF, "[REDACTED_NIF]")
    .replaceAll(BILKY_PASSWORD, "[REDACTED_PASSWORD]");
}

const browser = await chromium.connectOverCDP(
  `wss://production-ams.browserless.io/stealth?token=${BROWSERLESS_TOKEN}`
);

const contexts = browser.contexts();
const context = contexts[0] || await browser.newContext();

const pages = context.pages();
const page = pages[0] || await context.newPage();

try {
  console.log("Opening Bilky login...");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  console.log("Login page:", page.url());

  const nifInput = page.locator('input').filter({
    has: page.locator('xpath=..')
  });

  const inputs = await page.locator("input").evaluateAll((els) =>
    els.map((el) => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      autocomplete: el.autocomplete
    }))
  );

  console.log("LOGIN INPUTS");
  console.log(JSON.stringify(inputs, null, 2));

  const password = page.locator('input[type="password"]');

  const visibleInputs = page.locator("input:visible");
  const visibleCount = await visibleInputs.count();

  if (visibleCount < 2) {
    throw new Error(`Expected at least 2 visible inputs, found ${visibleCount}`);
  }

  await visibleInputs.nth(0).fill(BILKY_NIF);
  await password.fill(BILKY_PASSWORD);

  const buttons = page.locator("button:visible");
  console.log("LOGIN BUTTONS");

  console.log(
    JSON.stringify(
      await buttons.evaluateAll((els) =>
        els.map((el) => ({
          text: el.innerText?.trim(),
          type: el.type,
          id: el.id,
          class: el.className
        }))
      ),
      null,
      2
    )
  );

  const submitButton = page.locator('button[type="submit"]').first();

  if (await submitButton.count()) {
    await submitButton.click();
  } else {
    await buttons.last().click();
  }

  await page.waitForLoadState("domcontentloaded", {
    timeout: 30000
  });

  await page.waitForTimeout(3000);

  console.log("After login URL:", page.url());
  console.log("Page title:", await page.title());

  console.log("Visible links:");
  const links = await page.locator("a:visible").evaluateAll((els) =>
    els.map((el) => ({
      text: el.innerText?.trim(),
      href: el.href,
      id: el.id,
      class: el.className
    }))
  );
  console.log(JSON.stringify(links.slice(0, 100), null, 2));

  const workshiftLink = page
    .getByText("Workshift control", { exact: true })
    .first();

  if (!(await workshiftLink.count())) {
    throw new Error("Could not find Workshift control link");
  }

  await workshiftLink.click();

  await page.waitForLoadState("domcontentloaded", {
    timeout: 30000
  });

  await page.waitForTimeout(3000);

  console.log("Workshift URL:", page.url());
  console.log("Workshift title:", await page.title());

  fs.mkdirSync("diagnostics", { recursive: true });

  const html = await page.content();

  fs.writeFileSync(
    "diagnostics/workshift.html",
    sanitizeHtml(html),
    "utf8"
  );

  await page.screenshot({
    path: "diagnostics/workshift.png",
    fullPage: true
  });

  console.log("\n===== ALL VISIBLE BUTTONS =====");
  console.log(
    JSON.stringify(
      await page.locator("button:visible").evaluateAll((els) =>
        els.map((el) => ({
          text: el.innerText?.trim(),
          id: el.id,
          class: el.className,
          title: el.getAttribute("title"),
          dataTitle: el.getAttribute("data-title"),
          dataBsTitle: el.getAttribute("data-bs-title"),
          ariaLabel: el.getAttribute("aria-label")
        }))
      ),
      null,
      2
    )
  );

  console.log("\n===== VISIBLE INPUTS =====");
  console.log(
    JSON.stringify(
      await page.locator("input:visible").evaluateAll((els) =>
        els.map((el) => ({
          value: el.value,
          type: el.type,
          name: el.name,
          id: el.id,
          class: el.className,
          placeholder: el.placeholder
        }))
      ),
      null,
      2
    )
  );

  console.log("\n===== ELEMENTS WITH TITLE OR DATA TITLE =====");
  console.log(
    JSON.stringify(
      await page.locator(
        '[title], [data-title], [data-bs-title], [data-bs-original-title]'
      ).evaluateAll((els) =>
        els.map((el) => ({
          tag: el.tagName,
          text: el.innerText?.trim(),
          title: el.getAttribute("title"),
          dataTitle: el.getAttribute("data-title"),
          dataBsTitle: el.getAttribute("data-bs-title"),
          dataBsOriginalTitle: el.getAttribute("data-bs-original-title"),
          class: el.className,
          id: el.id
        }))
      ),
      null,
      2
    )
  );

  console.log("\n===== TEXT MATCHES =====");

  const bodyText = await page.locator("body").innerText();

  for (const needle of [
    "26",
    "27",
    "08:00",
    "16:00",
    "Clock in/out",
    "Sign",
    "SIGNED",
    "PENDING",
    "Pending signature"
  ]) {
    console.log(
      `${needle}:`,
      bodyText.includes(needle) ? "FOUND" : "NOT FOUND"
    );
  }

  console.log("\n===== POSSIBLE DAY BLOCKS =====");

  const candidates = await page.locator("div").evaluateAll((divs) => {
    return divs
      .map((el, index) => {
        const text = el.innerText?.trim() || "";

        if (
          (
            text.includes("26") ||
            text.includes("27")
          ) &&
          (
            text.includes("08:00") ||
            text.includes("16:00") ||
            text.includes("Clock in/out")
          )
        ) {
          return {
            index,
            text: text.slice(0, 1200),
            id: el.id,
            class: el.className
          };
        }

        return null;
      })
      .filter(Boolean)
      .slice(0, 50);
  });

  console.log(JSON.stringify(candidates, null, 2));

  console.log("\nDIAGNOSTIC FINISHED");
} catch (error) {
  console.error("\nDIAGNOSTIC FAILED");
  console.error(error);

  try {
    fs.mkdirSync("diagnostics", { recursive: true });

    await page.screenshot({
      path: "diagnostics/error.png",
      fullPage: true
    });

    fs.writeFileSync(
      "diagnostics/error.html",
      sanitizeHtml(await page.content()),
      "utf8"
    );
  } catch {}

  process.exitCode = 1;
} finally {
  await browser.close();
}
