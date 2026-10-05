const GITHUB_OWNER = "nikmad-ops";
const GITHUB_REPO = "bilky_v1";
const V4_WORKFLOW = "workshift-v4-master.yml";
const STATUS_WORKFLOW = "status-report.yml";
const STATE_TTL_SECONDS = 172800;

function madridParts(date = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date).map(({ type, value }) => [type, value])
  );
}

function madridDate(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function minutes(parts) {
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isWeekday(parts) {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday);
}

function inDispatchWindow(parts, action) {
  const now = minutes(parts);
  if (action === "morning") return now >= 7 * 60 + 55 && now <= 8 * 60 + 25;
  if (action === "evening") return now >= 16 * 60 + 30 && now <= 17 * 60;
  return false;
}

async function githubRequest(env, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bilky-v4-nik-control-plane",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status}: ${await response.text()}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function dispatchWorkflow(env, workflow, inputs) {
  await githubRequest(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
}

async function dispatchScheduledOnce(env, date, action) {
  const key = `v4:scheduled:nik:${date}:${action}`;

  if (await env.BILKY_STATE.get(key)) {
    console.log(`Already dispatched: ${key}`);
    return { ok: true, dispatched: false, duplicate: true };
  }

  await dispatchWorkflow(env, V4_WORKFLOW, {
    client_id: "nik",
    client_label: "Nik",
    airtop_profile: "bilky-nik",
    action,
    mode: "scheduled",
  });

  await env.BILKY_STATE.put(
    key,
    JSON.stringify({
      client: "nik",
      date,
      action,
      mode: "scheduled",
      dispatchedAt: new Date().toISOString(),
    }),
    { expirationTtl: STATE_TTL_SECONDS }
  );

  console.log(`Scheduled v4 dispatched: ${key}`);
  return { ok: true, dispatched: true, duplicate: false };
}

async function dispatchManualOnce(env, action, requestId) {
  const now = madridParts();

  if (!isWeekday(now)) {
    return { ok: true, dispatched: false, weekend: true };
  }

  if (!["morning", "evening"].includes(action)) {
    return { ok: false, error: "invalid-action" };
  }

  const key = `v4:manual-request:nik:${requestId}`;

  if (await env.BILKY_STATE.get(key)) {
    return { ok: true, dispatched: false, duplicate: true };
  }

  await dispatchWorkflow(env, V4_WORKFLOW, {
    client_id: "nik",
    client_label: "Nik",
    airtop_profile: "bilky-nik",
    action,
    mode: "manual",
  });

  await env.BILKY_STATE.put(
    key,
    JSON.stringify({
      client: "nik",
      action,
      mode: "manual",
      requestId,
      dispatchedAt: new Date().toISOString(),
    }),
    { expirationTtl: STATE_TTL_SECONDS }
  );

  return { ok: true, dispatched: true, duplicate: false };
}

async function dispatchStatusOnce(env, chatId, requestId) {
  const key = `v4:status-request:nik:${requestId}`;

  if (await env.BILKY_STATE.get(key)) {
    return { ok: true, dispatched: false, duplicate: true };
  }

  await dispatchWorkflow(env, STATUS_WORKFLOW, {
    chat_id: String(chatId),
  });

  await env.BILKY_STATE.put(
    key,
    JSON.stringify({
      client: "nik",
      mode: "status",
      chatId: String(chatId),
      requestId,
      dispatchedAt: new Date().toISOString(),
    }),
    { expirationTtl: 86400 }
  );

  return { ok: true, dispatched: true, duplicate: false };
}

export default {
  async scheduled(controller, env) {
    const parts = madridParts(new Date(controller.scheduledTime));

    if (!isWeekday(parts)) return;

    const date = madridDate(parts);

    for (const action of ["morning", "evening"]) {
      if (!inDispatchWindow(parts, action)) continue;
      await dispatchScheduledOnce(env, date, action);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        service: "bilky-v4-nik-control-plane",
        architecture: "v4",
        client: "nik",
        workflow: V4_WORKFLOW,
        state: "dedicated-kv",
        retries: "inside-single-github-run",
        retryIntervalMinutes: 3,
      });
    }

    if (url.pathname.startsWith("/internal/")) {
      if (url.hostname !== "nik-v4.internal") {
        return new Response("Not found", { status: 404 });
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      if (url.pathname === "/internal/manual") {
        const payload = await request.json().catch(() => ({}));
        const action = String(payload.action || "");
        const requestId = String(payload.request_id || "");

        if (!requestId) {
          return Response.json(
            { ok: false, error: "missing-request-id" },
            { status: 400 }
          );
        }

        const result = await dispatchManualOnce(env, action, requestId);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }

      if (url.pathname === "/internal/status") {
        const payload = await request.json().catch(() => ({}));
        const chatId = String(payload.chat_id || "");
        const requestId = String(payload.request_id || "");

        if (!chatId || !requestId) {
          return Response.json(
            { ok: false, error: "missing-fields" },
            { status: 400 }
          );
        }

        const result = await dispatchStatusOnce(env, chatId, requestId);
        return Response.json(result);
      }

      return new Response("Not found", { status: 404 });
    }

    return new Response("bilky v4 nik control plane", { status: 200 });
  },
};