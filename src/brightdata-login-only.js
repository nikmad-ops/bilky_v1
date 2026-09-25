import { chromium } from "playwright-core";

const { BILKY_NIF, BILKY_PASSWORD, BRIGHTDATA_CDP_URL } = process.env;
for (const [k,v] of Object.entries({BILKY_NIF,BILKY_PASSWORD,BRIGHTDATA_CDP_URL})) {
  if (!v) throw new Error(`Missing ${k}`);
}

const WORKSHIFT_URL="https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const browser=await chromium.connectOverCDP(BRIGHTDATA_CDP_URL,{timeout:120000});
try {
  const context=browser.contexts()[0];
  const page=context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);

  console.log("OPEN direct Workshift");
  await page.goto(WORKSHIFT_URL,{waitUntil:"domcontentloaded",timeout:120000});
  console.log("AFTER_OPEN url="+page.url());

  if (!page.url().includes("/auth/login")) {
    console.log("STOP: already authenticated; no further click performed.");
    process.exit(0);
  }

  const inputs=page.locator("input:visible");
  const pass=page.locator('input[type="password"]').first();
  const submit=page.locator('button[type="submit"]').first();

  await inputs.nth(0).fill(BILKY_NIF);
  console.log("NIF_FILLED");
  await pass.fill(BILKY_PASSWORD);
  console.log("PASSWORD_FILLED");

  console.log("LOGIN_CLICK_ONLY");
  await submit.click({noWaitAfter:true});

  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    if(!page.url().includes("/auth/login")) break;
    await new Promise(r=>setTimeout(r,500));
  }

  console.log("AFTER_LOGIN url="+page.url());
  console.log("AUTHENTICATED="+String(!page.url().includes("/auth/login")));
  console.log("STOP: no Workshift/clock action performed.");
} finally {
  await browser.close().catch(()=>{});
}
