import fs from "node:fs";
import { factsFromHttp200 } from "../src/production-core.js";

const config = JSON.parse(fs.readFileSync("config/clients.v4.1.json", "utf8"));
const workflow = fs.readFileSync(".github/workflows/workshift-v4.1-master.yml", "utf8");
const statusWorkflow = fs.readFileSync(".github/workflows/status-v4.1.yml", "utf8");
const controlPlane = fs.readFileSync("cloudflare/bilky-v4.1-control-plane.js", "utf8");
const alenaBridge = fs.readFileSync("cloudflare/bilky-clients-scheduler-alena-v4.1-bridge.js", "utf8");

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

const productionCore = fs.readFileSync("src/production-core.js", "utf8");
const statusCore = fs.readFileSync("src/status-core.js", "utf8");

assert(!productionCore.includes("CAPTCHA_SOLVER_BUDGET_MS"), "CAPTCHA must not have a separate solver budget");
assert(productionCore.includes("AIRTOP_SESSION_BUDGET_MS = 28000"), "Production session budget must remain 28000ms");

const noisyMorning = '<span>irrelevant 08:17:00</span><i data-original-title="05/10/2026 08:00:46" class="fe fe-clock"></i>';
const parsedMorning = factsFromHttp200(noisyMorning);
assert(parsedMorning.morning === "08:00:46", "Morning fact parser must ignore unrelated times");
assert(parsedMorning.evening === null, "Morning-only response must not invent Evening fact");

const parsedEvening = factsFromHttp200(
  '<i data-original-title="05/10/2026 08:00:46" class="fe fe-clock"></i>' +
  '<i data-original-title="05/10/2026 16:35:46" class="fe fe-clock"></i>'
);
assert(parsedEvening.morning === "08:00:46", "Evening response must retain Morning fact");
assert(parsedEvening.evening === "16:35:46", "Evening response must parse the second clock fact");
assert(statusCore.includes('process.env.AIRTOP_PROFILE_NAME || "bilky-nik"'), "Status core must accept per-user Airtop profile");
assert(!statusCore.includes(':visible'), "Status dashboard detection must not depend on :visible");

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

for (const required of [
  'WORKSHIFT_WORKFLOW = "workshift-v4.1-master.yml"',
  'STATUS_WORKFLOW = "status-v4.1.yml"',
  'enabled: true',
  'enabled: false',
  'v4.1:scheduled:',
  'v4.1:manual:',
  'v4.1:status:',
  'now <= 9 * 60 + 30',
  'now <= 18 * 60 + 5',
]) {
  assert(controlPlane.includes(required), `Missing control-plane invariant: ${required}`);
}

assert(
  (controlPlane.match(/enabled: false/g) || []).length >= 2,
  "Alena and Irakli must remain disabled in v4.1 control plane before migration"
);

for (const required of [
  "github_environment",
  "client_id",
  "client_label",
  "recipient",
  "AIRTOP_PROFILE_NAME",
]) {
  assert(statusWorkflow.includes(required), `Missing v4.1 status invariant: ${required}`);
}

for (const required of [
  '{ id: "alena", name: "Alena", repo: "nikmad-ops/bilky_client_01", scheduled: false }',
  '{ id: "irakli", name: "Irakli", repo: "nikmad-ops/bilky_client_02", scheduled: true }',
  'if (client.id==="nik" || client.id==="alena")',
  'role:"alena"',
  'client_id:"alena"',
  'recipient:"client"',
  'if (id==="nik" || id==="alena")',
  'if (id==="alena")',
  'const r=await startManual(env,"alena",id,action)',
]) {
  assert(alenaBridge.includes(required), `Missing Alena migration bridge invariant: ${required}`);
}

assert(
  alenaBridge.includes('dispatchStatus(env,c,chat,msg.message_id,"alena","client")'),
  "Alena Status must stay self-only and use client recipient"
);
assert(
  alenaBridge.includes('targetKeyboard(["alena","irakli"],"alena-run-target")'),
  "Alena Run must retain Alena/Irakli target selection"
);

console.log("v4.1 static architecture checks passed");

// Triggered automatically on v4.1 architecture changes.
