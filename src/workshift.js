import fs from "node:fs";
import {
  createBilkyCore,
  dayDuration,
  getMadridDate,
  log,
} from "./bilky-core.js";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  ACTION,
  EXECUTE,
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  ACTION,
  EXECUTE,
})) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

if (!["morning", "evening"].includes(ACTION)) {
  throw new Error(`ACTION must be morning or evening. Got: ${ACTION}`);
}

if (EXECUTE !== "true") {
  throw new Error("Execution blocked by internal kill switch: EXECUTE must equal true");
}

const targetDate = getMadridDate();

const bilky = createBilkyCore({
  nif: BILKY_NIF,
  password: BILKY_PASSWORD,
  browserlessToken: BROWSERLESS_TOKEN,
});

function writeResult(result) {
  fs.writeFileSync(
    "run-result.json",
    JSON.stringify(
      {
        date: targetDate,
        action: ACTION,
        ...result,
      },
      null,
      2
    ),
    "utf8"
  );
}

async function runAction({ page, setStage }) {
  setStage("read-current-state");

  const state = await bilky.readDayState(page, targetDate);
  bilky.printState(state);

  if (ACTION === "morning") {
    const result = await bilky.clock(
      page,
      state,
      "morning",
      targetDate,
      setStage
    );

    return {
      fact: result.fact || state.morning.fact || null,
      alreadyDone: result.alreadyDone,
      httpAccepted: Boolean(result.httpAccepted || result.alreadyDone),
    };
  }

  const clockResult = await bilky.clock(
    page,
    state,
    "evening",
    targetDate,
    setStage
  );

  const eveningFact =
    clockResult.fact ||
    state.evening.fact ||
    null;

  return {
    fact: eveningFact,
    alreadyDone: clockResult.alreadyDone,
    httpAccepted: Boolean(clockResult.httpAccepted || clockResult.alreadyDone),
    duration: dayDuration(state.morning.fact, eveningFact),
  };
}

async function main() {
  log(`TARGET_DATE=${targetDate}`);
  log(`ACTION=${ACTION}`);

  const result = await bilky.runWithRetries(
    `Bilky ${ACTION}`,
    runAction
  );

  writeResult(result);
  log(`${ACTION.toUpperCase()} SUCCESS`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    try {
      fs.writeFileSync(
        "run-error.txt",
        String(error?.message || error || "Unknown error").split("\n")[0].slice(0, 300),
        "utf8"
      );
    } catch {}

    console.error(error);
    process.exit(1);
  });
