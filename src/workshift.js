import {
  createBilkyCore,
  dayDuration,
  displayDate,
  getMadridDate,
  log,
  shortFact,
} from "./bilky-core.js";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
})) {
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`
    );
  }
}

if (
  ![
    "morning",
    "evening",
  ].includes(ACTION)
) {
  throw new Error(
    `ACTION must be morning or evening. Got: ${ACTION}`
  );
}

if (
  EXECUTE !==
  "true"
) {
  throw new Error(
    "Execution blocked by internal kill switch: EXECUTE must equal true"
  );
}

const targetDate =
  getMadridDate();

async function sendTelegram(
  message
) {
  const response =
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify({
            chat_id:
              TELEGRAM_CHAT_ID,
            text:
              message,
          }),
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Telegram failed: ${response.status} ${await response.text()}`
    );
  }
}

const bilky =
  createBilkyCore({
    nif:
      BILKY_NIF,
    password:
      BILKY_PASSWORD,
    browserlessToken:
      BROWSERLESS_TOKEN,
  });

async function runAction({
  page,
  setStage,
}) {
  setStage(
    "read-current-state"
  );

  let state =
    await bilky.readDayState(
      page,
      targetDate
    );

  bilky.printState(
    state
  );

  if (
    ACTION ===
    "morning"
  ) {
    const result =
      await bilky.clock(
        page,
        state,
        "morning",
        targetDate,
        setStage
      );

    return {
      action:
        "morning",
      fact:
        result.fact,
    };
  }

  const clockResult =
    await bilky.clock(
      page,
      state,
      "evening",
      targetDate,
      setStage
    );

  setStage(
    "ensure-signed"
  );

  const finalState =
    await bilky.signDay(
      page,
      targetDate,
      setStage
    );

  const duration =
    dayDuration(
      finalState.morning.fact,
      finalState.evening.fact
    );

  if (!duration) {
    throw new Error(
      "Unable to calculate DAY from morning/evening facts"
    );
  }

  return {
    action:
      "evening",
    fact:
      clockResult.fact ||
      finalState.evening.fact,
    duration,
  };
}

async function main() {
  log(
    `TARGET_DATE=${targetDate}`
  );

  log(
    `ACTION=${ACTION}`
  );

  let result;

  try {
    result =
      await bilky.runWithRetries(
        `Bilky ${ACTION}`,
        runAction
      );
  } catch (error) {
    const label =
      ACTION ===
      "morning"
        ? "УТРО"
        : "ВЕЧЕР";

    try {
      await sendTelegram(
        `❌ Bilky ${displayDate(targetDate)}: ${label}. ERROR after 3 attempts: ${error.cause?.message || error.message}`
      );
    } catch (
      telegramError
    ) {
      console.error(
        `Telegram error notification failed: ${telegramError.message}`
      );
    }

    throw error;
  }

  if (
    result.action ===
    "morning"
  ) {
    await sendTelegram(
      `✅ Bilky ${displayDate(targetDate)}: УТРО. Факт: ${shortFact(result.fact)}`
    );

    log(
      "MORNING SUCCESS"
    );

    return;
  }

  await sendTelegram(
    `✅ Bilky ${displayDate(targetDate)}: ВЕЧЕР. Факт: ${shortFact(result.fact)}, Signed. DAY ${result.duration}`
  );

  log(
    "EVENING SUCCESS"
  );
}

await main();
