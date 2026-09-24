import { chromium } from "playwright-core";

const { BILKY_NIF, BILKY_PASSWORD, BROWSERLESS_TOKEN } = process.env;
const date = new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Madrid",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

const browser = await chromium.connectOverCDP("wss://production-ams.browserless.io/stealth?token=" + BROWSERLESS_TOKEN + "&solveCaptchas=true");
try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.goto("https://panel.bilky.es/auth/login",{waitUntil:"domcontentloaded",timeout:20000});
  const inputs=page.locator("input:visible");
  await inputs.nth(0).fill(BILKY_NIF);
  await page.locator('input[type="password"]').first().fill(BILKY_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  for(let i=0;i<60 && page.url().includes("/auth/login");i++) await page.waitForTimeout(500);

  const link=page.locator('a[href*="/employee/hour-registration/hour-registration/show/"]:visible').first();
  await link.waitFor({state:"visible",timeout:20000});
  await link.click();

  const container=page.locator("#container_"+date);
  await container.waitFor({state:"visible",timeout:45000});
  const row=container.locator("tr").filter({hasText:/First shift|Primer turno/}).first();
  const cells=row.locator("td.hr-container");
  console.log("CELL_COUNT="+await cells.count());
  for(let i=0;i<await cells.count();i++){
    const cell=cells.nth(i);
    console.log("CELL_"+i+"_TEXT="+(await cell.innerText()).replace(/\s+/g," "));
    console.log("CELL_"+i+"_HTML="+await cell.innerHTML());
    const vals=await cell.locator('i.fe-clock[data-original-title]').evaluateAll(es=>es.map(e=>e.getAttribute("data-original-title")));
    console.log("CELL_"+i+"_FACTS="+JSON.stringify(vals));
  }
} finally {
  await browser.close().catch(()=>{});
}
