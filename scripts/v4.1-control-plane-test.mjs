import assert from "node:assert/strict";
import worker from "../cloudflare/bilky-v4.1-control-plane.js";

class MockKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({
    url: String(url),
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });
  return new Response(null, { status: 204 });
};

function env() {
  return {
    GITHUB_TOKEN: "test-token",
    BILKY_STATE: new MockKV(),
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
    TELEGRAM_CHAT_ID: "123",
    WEBHOOK_SETUP_KEY: "telegram-webhook-secret",
  };
}

function scheduledTime(iso) {
  return { scheduledTime: Date.parse(iso) };
}

async function runScheduled(iso) {
  calls.length = 0;
  const e = env();
  await worker.scheduled(scheduledTime(iso), e);
  return { calls: [...calls], env: e };
}

// 07:55 Madrid on 2026-10-05 = 05:55 UTC.
{
  const r = await runScheduled("2026-10-05T05:55:00Z");
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].url, /workshift-v4\.1-master\.yml\/dispatches$/);
  assert.deepEqual(r.calls[0].body.inputs, {
    client_id: "nik",
    client_label: "Nik",
    airtop_profile: "bilky-nik",
    github_environment: "client-nik",
    action: "morning",
    mode: "scheduled",
  });
}

// End of expanded Morning window is allowed.
{
  const r = await runScheduled("2026-10-05T07:30:00Z"); // 09:30 Madrid
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body.inputs.action, "morning");
}

// One minute later is blocked.
{
  const r = await runScheduled("2026-10-05T07:31:00Z"); // 09:31 Madrid
  assert.equal(r.calls.length, 0);
}

// End of expanded Evening window is allowed.
{
  const r = await runScheduled("2026-10-05T16:05:00Z"); // 18:05 Madrid
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body.inputs.action, "evening");
}

// One minute later is blocked.
{
  const r = await runScheduled("2026-10-05T16:06:00Z"); // 18:06 Madrid
  assert.equal(r.calls.length, 0);
}

// Disabled clients must never be scheduled.
{
  const r = await runScheduled("2026-10-05T05:55:00Z");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body.inputs.client_id, "nik");
}

// Duplicate scheduled dispatch must not create a second GitHub run.
{
  calls.length = 0;
  const e = env();
  const event = scheduledTime("2026-10-05T05:55:00Z");
  await worker.scheduled(event, e);
  await worker.scheduled(event, e);
  assert.equal(calls.length, 1);
}

// Admin Manual Run for Nik is allowed and uses v4.1.
{
  calls.length = 0;
  const e = env();
  const req = new Request("https://nik-v4.internal/internal/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      role: "admin",
      client_id: "nik",
      action: "morning",
      request_id: "manual-test-1",
    }),
  });
  const res = await worker.fetch(req, e);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.dispatched, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.inputs.github_environment, "client-nik");
}

// Alena/Irakli stay impossible to dispatch through v4.1 until enabled.
{
  calls.length = 0;
  const e = env();
  const req = new Request("https://nik-v4.internal/internal/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      role: "admin",
      client_id: "alena",
      action: "morning",
      request_id: "manual-test-disabled",
    }),
  });
  const res = await worker.fetch(req, e);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "client-not-enabled");
  assert.equal(calls.length, 0);
}

// Admin Status for Nik uses generic v4.1 Status workflow.
{
  calls.length = 0;
  const e = env();
  const req = new Request("https://nik-v4.internal/internal/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      role: "admin",
      client_id: "nik",
      recipient: "admin",
      chat_id: "123",
      request_id: "status-test-1",
    }),
  });
  const res = await worker.fetch(req, e);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.dispatched, true);
  assert.match(calls[0].url, /status-v4\.1\.yml\/dispatches$/);
  assert.equal(calls[0].body.inputs.github_environment, "client-nik");
  assert.equal(calls[0].body.inputs.recipient, "admin");
}

// Nik personal Telegram Status is accepted and dispatches generic v4.1 Status.
{
  calls.length = 0;
  const e = env();
  const req = new Request("https://bilky-scheduler.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "telegram-webhook-secret",
    },
    body: JSON.stringify({
      message: {
        message_id: 77,
        chat: { id: 123 },
        text: "Status",
      },
    }),
  });
  const res = await worker.fetch(req, e);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /api\.telegram\.org\/bottelegram-test-token\/sendMessage$/);
  assert.match(calls[1].url, /status-v4\.1\.yml\/dispatches$/);
  assert.equal(calls[1].body.inputs.client_id, "nik");
  assert.equal(calls[1].body.inputs.recipient, "client");
}

// Telegram webhook rejects an invalid secret.
{
  calls.length = 0;
  const e = env();
  const req = new Request("https://bilky-scheduler.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
    },
    body: JSON.stringify({ message: { chat: { id: 123 }, text: "Status" } }),
  });
  const res = await worker.fetch(req, e);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
}

// Direct public access to internal dispatch endpoints is blocked.
{
  calls.length = 0;
  const e = env();
  const req = new Request("https://example.com/internal/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const res = await worker.fetch(req, e);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
}

console.log("v4.1 control-plane offline tests passed");
