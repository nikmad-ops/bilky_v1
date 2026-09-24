import { chromium } from "playwright-core";

const nif = process.env.BILKY_NIF;
const password = process.env.BILKY_PASSWORD;
const token = process.env.BROWSERLESS_TOKEN;
if (!nif || !password || !token) throw new Error("Missing environment");

const browser = await chromium.connectOverCDP("wss://production-ams.browserless.io/stealth?token=" + token + "&solveCaptchas=true");

try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  await page.goto("https://panel.bilky.es/auth/login", { waitUntil: "domcontentloaded", timeout: 20000 });

  const inputs = page.locator("input:visible");
  await inputs.nth(0).fill(nif);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && page.url().includes("/auth/login")) {
    await page.waitForTimeout(500);
  }

  console.log("LANDING_URL=" + page.url());

  const links = await page.locator("a:visible").evaluateAll((els) => els.map((a, i) => ({
    i,
    text: (a.innerText || a.textContent || "").trim().replace(/\s+/g, " "),
    href: a.href || "",
    id: a.id || "",
    className: String(a.className || ""),
    title: a.getAttribute("title") || "",
    aria: a.getAttribute("aria-label") || ""
  })));

  console.log("VISIBLE_LINKS_JSON=" + JSON.stringify(links));
  console.log("WORKSHIFT_LINKS_JSON=" + JSON.stringify(links.filter(x => /hour-registration|workshift|work shift/i.test(x.href + " " + x.text + " " + x.title + " " + x.aria))));
} finally {
  await browser.close().catch(() => {});
}
