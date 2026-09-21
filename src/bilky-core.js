import { chromium } from "playwright-core";
import fs from "node:fs";

export const LOGIN_URL =
  "https://panel.bilky.es/auth/login";

export const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";

export const TIMEZONE =
  "Europe/Madrid";

const RETRY_DELAYS_MS = [
  3 * 60 * 1000,
  5 * 60 * 1000,
];

export function log(message) {
  console.log(
    `[${new Date().toISOString()}] ${message}`
  );
}

export function getMadridDate() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(
      new Date()
    );

  const value =
    (type) =>
      parts.find(
        (part) =>
          part.type === type
      )?.value;

  return (
    `${value("year")}-${value("month")}-${value("day")}`
  );
}

export function displayDate(date) {
  const [y, m, d] =
    date.split("-");

  return `${d}.${m}.${y}`;
}

export function shortFact(time) {
  return time
    ? time.slice(0, 5)
    : "--:--";
}

export function minutesFromTime(time) {
  if (!time) {
    return null;
  }

  const [h, m] =
    time
      .slice(0, 5)
      .split(":")
      .map(Number);

  return h * 60 + m;
}

export function formatDuration(minutes) {
  return (
    `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
  );
}

export function dayDuration(
  morningFact,
  eveningFact
) {
  const start =
    minutesFromTime(
      morningFact
    );

  const end =
    minutesFromTime(
      eveningFact
    );

  if (
    start == null ||
    end == null ||
    end < start
  ) {
    return null;
  }

  return formatDuration(
    end - start
  );
}

function sanitizeStage(stage) {
  return String(
    stage || "unknown"
  )
    .replace(
      /[^a-zA-Z0-9_-]+/g,
      "-"
    )
    .slice(0, 80);
}

function extractTime(text) {
  const match =
    String(
      text || ""
    ).match(
      /\b\d{2}:\d{2}\b/
    );

  return match
    ? match[0]
    : null;
}

function extractFactTime(value) {
  if (!value) {
    return null;
  }

  const match =
    String(value).match(
      /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
    );

  return match
    ? match[1]
    : null;
}

async function sleep(ms) {
  await new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

export function createBilkyCore({
  nif,
  password,
  browserlessToken,
  diagnosticsDir =
    "diagnostics",
}) {
  if (!nif) {
    throw new Error(
      "Missing BILKY_NIF"
    );
  }

  if (!password) {
    throw new Error(
      "Missing BILKY_PASSWORD"
    );
  }

  if (!browserlessToken) {
    throw new Error(
      "Missing BROWSERLESS_TOKEN"
    );
  }

  fs.mkdirSync(
    diagnosticsDir,
    {
      recursive: true,
    }
  );

  const captchaSolverPages =
    new WeakSet();

  async function securityVerificationDetected(
    page
  ) {
    let title = "";
    let body = "";

    try {
      title =
        await page.title();
    } catch {}

    try {
      body =
        await page
          .locator("body")
          .innerText();
    } catch {}

    const frameUrls =
      page
        .frames()
        .map(
          (frame) =>
            frame.url()
        )
        .join(" ");

    const signal =
      [
        page.url(),
        title,
        body,
        frameUrls,
      ]
        .join(" ")
        .toLowerCase();

    return (
      signal.includes(
        "performing security verification"
      ) ||
      signal.includes(
        "verify you are human"
      ) ||
      signal.includes(
        "security verification"
      ) ||
      signal.includes(
        "just a moment"
      ) ||
      signal.includes(
        "cdn-cgi/challenge-platform"
      ) ||
      signal.includes(
        "challenges.cloudflare.com"
      )
    );
  }

  async function waitForSecurityVerificationToClear(
    page,
    {
      timeoutMs = 60000,
    } = {}
  ) {
    if (
      !(await securityVerificationDetected(
        page
      ))
    ) {
      return;
    }

    log(
      "Security verification detected. Waiting for Browserless automatic CAPTCHA solving."
    );

    const deadline =
      Date.now() +
      timeoutMs;

    while (
      Date.now() <
      deadline
    ) {
      await page.waitForTimeout(
        2000
      );

      if (
        !(await securityVerificationDetected(
          page
        ))
      ) {
        log(
          "Security verification cleared."
        );

        return;
      }
    }

    throw new Error(
      "Cloudflare security verification did not clear within 60 seconds"
    );
  }

  async function attachBrowserlessCaptchaLogging(
    page
  ) {
    try {
      const cdp =
        await page
          .context()
          .newCDPSession(
            page
          );

      cdp.on(
        "Browserless.captchaFound",
        (event) => {
          log(
            `Browserless CAPTCHA found: ${JSON.stringify(event)}`
          );
        }
      );

      cdp.on(
        "Browserless.captchaAutoSolved",
        (event) => {
          log(
            `Browserless CAPTCHA auto-solved: ${JSON.stringify(event)}`
          );
        }
      );
    } catch (error) {
      log(
        `Browserless CAPTCHA event logging unavailable: ${error.message}`
      );
    }
  }

  async function captureDiagnostics(
    page,
    attempt,
    stage,
    error
  ) {
    const safeStage =
      sanitizeStage(stage);

    const prefix =
      `${diagnosticsDir}/attempt-${attempt}-${safeStage}`;

    let title = "";
    let url = "";
    let body = "";
    let html = "";
    let frameUrls = [];
    let challenge = false;

    if (page) {
      try {
        title =
          await page.title();
      } catch {}

      try {
        url =
          page.url();
      } catch {}

      try {
        body =
          await page
            .locator("body")
            .innerText();
      } catch {}

      try {
        html =
          await page.content();
      } catch {}

      try {
        frameUrls =
          page
            .frames()
            .map(
              (frame) =>
                frame.url()
            );
      } catch {}

      try {
        challenge =
          await securityVerificationDetected(
            page
          );
      } catch {}

      try {
        await page.screenshot({
          path:
            `${prefix}.png`,
          fullPage: true,
        });
      } catch {}
    }

    try {
      fs.writeFileSync(
        `${prefix}.html`,
        html,
        "utf8"
      );
    } catch {}

    const diagnostic = {
      timestamp:
        new Date().toISOString(),
      attempt,
      stage,
      error:
        error?.message ||
        String(error),
      url,
      title,
      cloudflareDetected:
        challenge,
      frameUrls,
      bodyPreview:
        body.slice(
          0,
          12000
        ),
    };

    try {
      fs.writeFileSync(
        `${prefix}.json`,
        JSON.stringify(
          diagnostic,
          null,
          2
        ),
        "utf8"
      );
    } catch {}

    log(
      `DIAGNOSTIC attempt=${attempt} stage=${stage} url=${url} title=${title} cloudflare=${challenge}`
    );
  }

  async function assertNoSecurityVerification(
    page
  ) {
    if (
      !(await securityVerificationDetected(
        page
      ))
    ) {
      return;
    }

    if (
      captchaSolverPages.has(
        page
      )
    ) {
      await waitForSecurityVerificationToClear(
        page
      );

      if (
        !(await securityVerificationDetected(
          page
        ))
      ) {
        return;
      }
    }

    throw new Error(
      "Cloudflare security verification blocked Bilky page"
    );
  }

  async function loginAndOpenWorkshift(
    page,
    setStage
  ) {
    setStage(
      "open-login"
    );

    log(
      "Opening Bilky login."
    );

    await page.goto(
      LOGIN_URL,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 30000,
      }
    );

    await page.waitForTimeout(
      1200
    );

    await assertNoSecurityVerification(
      page
    );

    setStage(
      "login-form"
    );

    const visibleInputs =
      page.locator(
        "input:visible"
      );

    if (
      (await visibleInputs.count()) <
      2
    ) {
      throw new Error(
        "Bilky login fields not found"
      );
    }

    await visibleInputs
      .nth(0)
      .fill(nif);

    await page
      .locator(
        'input[type="password"]'
      )
      .first()
      .fill(password);

    const submit =
      page
        .locator(
          'button[type="submit"]'
        )
        .first();

    if (
      !(await submit.count())
    ) {
      throw new Error(
        "Bilky login button not found"
      );
    }

    setStage(
      "submit-login"
    );

    await submit.click();

    const deadline =
      Date.now() +
      25000;

    while (
      Date.now() <
      deadline
    ) {
      await page.waitForTimeout(
        1000
      );

      if (
        !page
          .url()
          .includes(
            "/auth/login"
          )
      ) {
        break;
      }

      if (
        await securityVerificationDetected(
          page
        )
      ) {
        throw new Error(
          "Cloudflare security verification blocked Bilky login"
        );
      }
    }

    if (
      page
        .url()
        .includes(
          "/auth/login"
        )
    ) {
      throw new Error(
        "Bilky login did not clear within 25 seconds"
      );
    }

    log(
      `Login OK. Current URL: ${page.url()}`
    );

    setStage(
      "open-workshift"
    );

    await page.goto(
      WORKSHIFT_URL,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 30000,
      }
    );

    await page.waitForTimeout(
      1500
    );

    log(
      `Workshift opened: ${page.url()}`
    );

    await assertNoSecurityVerification(
      page
    );
  }

  async function readShiftCell(
    cell
  ) {
    let planned = null;

    const input =
      cell
        .locator(
          "input.clockpicker"
        )
        .first();

    if (
      await input.count()
    ) {
      planned =
        await input.inputValue();
    } else {
      planned =
        extractTime(
          await cell.innerText()
        );
    }

    let fact = null;
    let factRaw = null;

    const factIcon =
      cell
        .locator(
          'i.fe-clock[data-original-title]'
        )
        .first();

    if (
      await factIcon.count()
    ) {
      factRaw =
        await factIcon.getAttribute(
          "data-original-title"
        );

      fact =
        extractFactTime(
          factRaw
        );
    }

    const clockButton =
      cell
        .locator(
          "a.clock"
        )
        .first();

    const buttonExists =
      (await clockButton.count()) >
      0;

    let buttonEnabled = false;
    let buttonId = null;

    if (buttonExists) {
      const className =
        (await clockButton.getAttribute(
          "class"
        )) || "";

      buttonEnabled =
        !className
          .split(/\s+/)
          .includes(
            "disabled"
          );

      buttonId =
        await clockButton.getAttribute(
          "id"
        );
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

  async function readDayState(
    page,
    date,
    {
      allowMissing = false,
    } = {}
  ) {
    const containerSelector =
      `#container_${date}`;

    const container =
      page.locator(
        containerSelector
      );

    if (
      allowMissing &&
      (await container.count()) ===
        0
    ) {
      return {
        exists: false,
        error:
          "day container not found",
      };
    }

    try {
      await container.waitFor({
        state: "visible",
        timeout: 15000,
      });
    } catch (error) {
      if (
        await securityVerificationDetected(
          page
        )
      ) {
        throw new Error(
          "Cloudflare security verification blocked Bilky page"
        );
      }

      throw error;
    }

    const row =
      container
        .locator("tr")
        .filter({
          hasText:
            /First shift|Primer turno/,
        })
        .first();

    if (
      !(await row.count())
    ) {
      throw new Error(
        `First shift row not found for ${date}`
      );
    }

    const shiftCells =
      row.locator(
        "td.hr-container"
      );

    if (
      (await shiftCells.count()) <
      2
    ) {
      throw new Error(
        `Expected morning and evening cells for ${date}`
      );
    }

    const morning =
      await readShiftCell(
        shiftCells.nth(0)
      );

    const evening =
      await readShiftCell(
        shiftCells.nth(1)
      );

    const signed =
      (await container
        .locator(
          ".badge-success"
        )
        .filter({
          hasText:
            /Signed|Firmado/,
        })
        .count()) > 0;

    const signAvailable =
      (await container
        .locator(
          "button#sign"
        )
        .count()) > 0;

    const text =
      await container.innerText();

    const pendingSignature =
      /pending signature|pendiente de firmar/i.test(
        text
      );

    return {
      exists: true,
      containerSelector,
      morning,
      evening,
      signed,
      signAvailable,
      pendingSignature,
      text,
    };
  }

  function printState(
    state
  ) {
    log(
      "----- DAY STATE -----"
    );

    log(
      `Morning: plan=${state.morning.planned ?? "NONE"} fact=${state.morning.fact ?? "NONE"} button=${state.morning.buttonExists ? "YES" : "NO"} enabled=${state.morning.buttonEnabled}`
    );

    log(
      `Evening: plan=${state.evening.planned ?? "NONE"} fact=${state.evening.fact ?? "NONE"} button=${state.evening.buttonExists ? "YES" : "NO"} enabled=${state.evening.buttonEnabled}`
    );

    log(
      `Signed=${state.signed} SignAvailable=${state.signAvailable} PendingSignature=${state.pendingSignature}`
    );

    log(
      "---------------------"
    );
  }

  async function clock(
    page,
    state,
    mode,
    date,
    setStage
  ) {
    const side =
      mode === "morning"
        ? state.morning
        : state.evening;

    const expectedPlan =
      mode === "morning"
        ? "08:00"
        : "16:00";

    if (
      side.fact
    ) {
      log(
        `${mode}: already clocked at ${side.fact}. No duplicate click.`
      );

      return {
        alreadyDone: true,
        fact: side.fact,
        state,
      };
    }

    if (
      side.planned !==
      expectedPlan
    ) {
      throw new Error(
        `${mode}: unexpected planned time ${side.planned}; expected ${expectedPlan}`
      );
    }

    if (
      !side.buttonExists
    ) {
      throw new Error(
        `${mode}: Clock in/out button does not exist`
      );
    }

    if (
      !side.buttonEnabled
    ) {
      throw new Error(
        `${mode}: Clock in/out button is disabled`
      );
    }

    if (
      mode === "evening" &&
      !state.morning.fact
    ) {
      throw new Error(
        "Evening blocked because morning fact is missing"
      );
    }

    const container =
      page.locator(
        state.containerSelector
      );

    const row =
      container
        .locator("tr")
        .filter({
          hasText:
            /First shift|Primer turno/,
        })
        .first();

    const cells =
      row.locator(
        "td.hr-container"
      );

    const cell =
      mode === "morning"
        ? cells.nth(0)
        : cells.nth(1);

    const button =
      cell
        .locator(
          "a.clock"
        )
        .first();

    setStage(
      `click-${mode}`
    );

    log(
      `CLICK ${mode}: ${side.buttonId}`
    );

    const responsePromise =
      page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(
              "/employee/hour-registration/clock-hour"
            ) &&
          response
            .request()
            .method() ===
            "POST",
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

    if (
      !response.ok()
    ) {
      throw new Error(
        `Bilky clock-hour returned HTTP ${response.status()}`
      );
    }

    setStage(
      `verify-${mode}`
    );

    await page.waitForTimeout(
      1500
    );

    await page.goto(
      WORKSHIFT_URL,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 30000,
      }
    );

    await page.waitForTimeout(
      1500
    );

    await assertNoSecurityVerification(
      page
    );

    const newState =
      await readDayState(
        page,
        date
      );

    printState(
      newState
    );

    const newSide =
      mode === "morning"
        ? newState.morning
        : newState.evening;

    if (
      !newSide.fact
    ) {
      throw new Error(
        `${mode}: POST succeeded but factual timestamp was not found after verification`
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

  async function signDay(
    page,
    date,
    setStage
  ) {
    setStage(
      "pre-sign-read"
    );

    let state =
      await readDayState(
        page,
        date
      );

    if (
      !state.evening.fact
    ) {
      throw new Error(
        "Refusing to sign: evening fact is missing"
      );
    }

    if (
      state.signed
    ) {
      log(
        "Day already SIGNED."
      );

      return state;
    }

    if (
      !state.signAvailable
    ) {
      throw new Error(
        "Evening completed but Sign button is unavailable"
      );
    }

    const signButton =
      page
        .locator(
          state.containerSelector
        )
        .locator(
          "button#sign"
        );

    setStage(
      "click-sign"
    );

    log(
      "Clicking Sign."
    );

    await signButton.click();

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
          response
            .url()
            .includes(
              "/employee/hour-registration/update-registration"
            ) &&
          response
            .request()
            .method() ===
            "POST",
        {
          timeout: 20000,
        }
      );

    log(
      "Confirming Sign."
    );

    await confirmButton.click();

    const response =
      await responsePromise;

    log(
      `update-registration HTTP ${response.status()}`
    );

    if (
      !response.ok()
    ) {
      throw new Error(
        `Bilky Sign returned HTTP ${response.status()}`
      );
    }

    setStage(
      "verify-sign"
    );

    await page.waitForTimeout(
      1500
    );

    await page.goto(
      WORKSHIFT_URL,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 30000,
      }
    );

    await page.waitForTimeout(
      1500
    );

    await assertNoSecurityVerification(
      page
    );

    state =
      await readDayState(
        page,
        date
      );

    printState(
      state
    );

    if (
      !state.signed
    ) {
      throw new Error(
        "Sign POST succeeded but SIGNED status was not confirmed"
      );
    }

    log(
      "SIGNED CONFIRMED."
    );

    return state;
  }

  async function runWithRetries(
    label,
    operation
  ) {
    let lastError =
      null;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt += 1
    ) {
      let browser =
        null;
      let page =
        null;
      let stage =
        "connect-browserless";

      const setStage =
        (value) => {
          stage = value;
          log(
            `STAGE=${stage}`
          );
        };

      try {
        log(
          `${label}: attempt ${attempt}/3 starting`
        );

        const solverEnabled =
          attempt === 3;

        const browserlessUrl =
          solverEnabled
            ? `wss://production-ams.browserless.io/stealth?token=${browserlessToken}&solveCaptchas=true`
            : `wss://production-ams.browserless.io/stealth?token=${browserlessToken}`;

        log(
          `${label}: Browserless mode = ${solverEnabled ? "stealth + CAPTCHA solver" : "stealth only"}`
        );

        browser =
          await chromium.connectOverCDP(
            browserlessUrl
          );

        const context =
          browser.contexts()[0] ||
          (await browser.newContext());

        page =
          context.pages()[0] ||
          (await context.newPage());

        if (
          solverEnabled
        ) {
          captchaSolverPages.add(
            page
          );
        }

        await attachBrowserlessCaptchaLogging(
          page
        );

        await loginAndOpenWorkshift(
          page,
          setStage
        );

        setStage(
          "operation"
        );

        const result =
          await operation({
            page,
            attempt,
            setStage,
          });

        log(
          `${label}: attempt ${attempt}/3 SUCCESS`
        );

        return result;
      } catch (error) {
        lastError =
          error;

        console.error(
          `${label}: attempt ${attempt}/3 FAILED at stage=${stage}: ${error.message}`
        );

        await captureDiagnostics(
          page,
          attempt,
          stage,
          error
        );

        if (
          attempt <
          3
        ) {
          const delayMs =
            RETRY_DELAYS_MS[
              attempt - 1
            ];

          const delayMinutes =
            Math.round(
              delayMs /
              60000
            );

          log(
            `${label}: waiting ${delayMinutes} minutes before completely new Browserless session`
          );

          if (browser) {
            try {
              await browser.close();
            } catch {}

            browser =
              null;
          }

          await sleep(
            delayMs
          );

          continue;
        }
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch {}
        }
      }
    }

    const finalError =
      new Error(
        `${label} failed after 3 attempts. Last error: ${lastError?.message || "Unknown error"}`
      );

    finalError.cause =
      lastError;

    throw finalError;
  }

  return {
    securityVerificationDetected,
    captureDiagnostics,
    loginAndOpenWorkshift,
    readDayState,
    printState,
    clock,
    signDay,
    runWithRetries,
  };
}
