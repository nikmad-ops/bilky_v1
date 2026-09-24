import { chromium } from "playwright-core";
import { createBilkyCore, getMadridDate } from "./bilky-core.js";

const bilky = createBilkyCore({
  nif: process.env.BILKY_NIF,
  password: process.env.BILKY_PASSWORD,
  browserlessToken: process.env.BROWSERLESS_TOKEN,
});

const browser = await chromium.connectOverCDP(
  "wss://production-ams.browserless.io/stealth?token=" +
  process.env.BROWSERLESS_TOKEN +
  "&solveCaptchas=true"
);

try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  const setStage = (s) => console.log("STAGE=" + s);

  await bilky.loginAndOpenWorkshift(page, setStage, true, getMadridDate());

  const date = getMadridDate();
  const row = page.locator("#container_" + date).locator("tr").filter({ hasText: /First shift|Primer turno/ }).first();
  const cells = row.locator("td.hr-container");
  const evening = cells.nth(1);
  const factIcon = evening.locator('i.fe-clock[data-original-title]').first();
  const button = evening.locator("a.clock").first();

  console.log("EVENING_FACT=" + ((await factIcon.count()) ? await factIcon.getAttribute("data-original-title") : "NONE"));
  console.log("EVENING_BUTTON_COUNT=" + await button.count());
  console.log("EVENING_HTML=" + await evening.innerHTML());
} finally {
  await browser.close().catch(() => {});
}
