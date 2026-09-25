import fs from "node:fs";
import {
  createProductionClient,
  madridDate,
  log,
} from "./production-core.js";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BRIGHTDATA_CDP_URL,
  ACTION,
  ATTEMPT,
  EXECUTE,
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BRIGHTDATA_CDP_URL,
  ACTION,
  ATTEMPT,
  EXECUTE,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

if (!["morning", "evening"].includes(ACTION)) {
  throw new Error(`ACTION must be morning or evening. Got: ${ACTION}`);
}

if (EXECUTE !== "true") {
  throw new Error("Execution blocked: EXECUTE must equal true");
}

const attempt = Number(ATTEMPT);
if (![1, 2, 3, 4, 5].includes(attempt)) {
  throw new Error(`ATTEMPT must be 1..5. Got: ${ATTEMPT}`);
}

const date = madridDate();

const client = createProductionClient({
  nif: BILKY_NIF,
  password: BILKY_PASSWORD,
  brightDataCdpUrl: BRIGHTDATA_CDP_URL,
  attempt,
});

async function main() {
  fs.rmSync("run-result.json", { force: true });
  fs.rmSync("run-error.txt", { force: true });
  fs.rmSync("run-committed.json", { force: true });

  log(`TARGET_DATE=${date}`);
  log(`ACTION=${ACTION}`);
  log(`ATTEMPT=${attempt}/5`);

  try {
    const result = await client.execute(ACTION, date);

    fs.writeFileSync(
      "run-result.json",
      JSON.stringify({ date, ...result }, null, 2),
      "utf8"
    );

    log(
      `SUCCESS status=${result.status} fact=${result.fact || "NONE"} http=${result.httpStatus ?? "N/A"}`
    );
  } catch (error) {
    const message = String(error?.message || error || "Unknown error")
      .split("\n")[0]
      .slice(0, 300);

    fs.writeFileSync("run-error.txt", message, "utf8");
    throw error;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
