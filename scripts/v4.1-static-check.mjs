import fs from "node:fs";

const config = JSON.parse(fs.readFileSync("config/clients.v4.1.json", "utf8"));
const workflow = fs.readFileSync(".github/workflows/workshift-v4.1-master.yml", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(config.version === "4.1", "Config version must be 4.1");
assert(config.clients?.nik?.enabled === true, "Nik must be enabled for pilot");
assert(config.clients?.alena?.enabled === false, "Alena must remain disabled before migration");
assert(config.clients?.irakli?.enabled === false, "Irakli must remain disabled before migration");
assert(config.clients?.irakli?.telegramRecipientMode === "client-secret", "Irakli routing must stay secret-configured");
assert(config.recovery?.cycles === 3, "Recovery cycles must equal 3");
assert(config.recovery?.attemptsPerCycle === 5, "Attempts per cycle must equal 5");
assert(config.recovery?.retryMinutes === 3, "Retry interval must equal 3 minutes");
assert(config.recovery?.airtopSessionBudgetMs === 28000, "Airtop session budget must remain 28000ms");
assert(config.recovery?.postLoginStateTimeoutMs === 8000, "Post-login timeout must remain 8000ms");

for (const required of [
  "timeout-minutes: 70",
  "for CYCLE in 1 2 3",
  "for LOCAL_ATTEMPT in 1 2 3 4 5",
  "sleep 180",
  "requires_attention",
  "Automatic recovery exhausted after 15 attempts",
  "github_environment",
]) {
  assert(workflow.includes(required), `Missing v4.1 workflow invariant: ${required}`);
}

assert(!workflow.includes("ERROR after 5/5"), "User-facing 5/5 ERROR must not exist in v4.1 workflow");

console.log("v4.1 static architecture checks passed");

// Triggered automatically on v4.1 architecture changes.
