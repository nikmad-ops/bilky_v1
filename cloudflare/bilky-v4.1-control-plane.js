const GITHUB_OWNER = "nikmad-ops";
const GITHUB_REPO = "bilky_v1";
const WORKSHIFT_WORKFLOW = "workshift-v4.1-master.yml";
const STATUS_WORKFLOW = "status-v4.1.yml";
const STATE_TTL_SECONDS = 172800;

const CLIENTS = {
  nik: {
    id: "nik",
    label: "Nik",
    enabled: true,
    scheduled: true,
    airtopProfile: "bilky-nik",
    githubEnvironment: "client-nik",
  },
  alena: {
    id: "alena",
    label: "Alena",
    enabled: true,
    scheduled: true,
    airtopProfile: "bilky-alena",
    githubEnvironment: "client-alena",
  },
  irakli: {
    id: "irakli",
    label: "Irakli",
    enabled: true,
    scheduled: true,
    airtopProfile: "bilky-irakli",
    githubEnvironment: "client-irakli",
  },
};

const PERMISSIONS = {
  admin: {
    runTargets: ["nik", "alena", "irakli"],
    statusTargets: ["nik", "alena", "irakli"],
  },
  alena: {
    runTargets: ["alena", "irakli"],
    statusTargets: ["alena"],
  },
};

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
  if (action === "morning") return now >= 7 * 60 + 55 && now <= 9 * 60 + 30;
  if (action === "evening") return now >= 16 * 60 + 30 && now <= 18 * 60 + 5;
  return false;
}

function clientById(id, { requireEnabled = true } = {}) {
  const client = CLIENTS[String(id || "")];
  if (!client) return null;
  if (requireEnabled && !client.enabled) return null;
  return client;
}

function allowed(role, kind, clientId) {
  const rule = PERMISSIONS[role];
  if (!rule) return role === clientId;
  const targets = kind === "status" ? rule.statusTargets : rule.runTargets;
  return targets.includes(clientId);
}

async function getNonWorkingDay(env, clientId, date) {
  if (!env.BILKY_DB) {
    throw new Error("BILKY_DB binding is missing");
  }

  return env.BILKY_DB
    .prepare(
      "SELECT date, reason FROM non_working_days WHERE user_id = ? AND date = ? LIMIT 1"
    )
    .bind(clientId, date)
    .first();
}

async function getNonWorkingDays(env, clientId) {
  if (!env.BILKY_DB) {
    throw new Error("BILKY_DB binding is missing");
  }

  const result = await env.BILKY_DB
    .prepare(
      "SELECT date, reason FROM non_working_days WHERE user_id = ? ORDER BY date"
    )
    .bind(clientId)
    .all();

  return Array.isArray(result?.results) ? result.results : [];
}

const TELEGRAM_API = "https://api.telegram.org";

function isStatusCommand(text) {
  return ["status", "/status", "статус", "/статус"].includes(
    String(text || "").trim().toLowerCase()
  );
}

function isRunCommand(text) {
  return ["run", "/run", "запуск", "/запуск"].includes(
    String(text || "").trim().toLowerCase()
  );
}

async function telegramCall(token, method, payload) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Telegram ${method} HTTP ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

async function telegramSend(env, text, extra = {}) {
  return telegramCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    ...extra,
  });
}

async function telegramAnswer(env, callbackId) {
  return telegramCall(env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", {
    callback_query_id: callbackId,
  });
}

async function telegramWebhookSecret(botToken) {
  const input = new TextEncoder().encode(`bilky-v4.1:${botToken}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function selfActionKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Morning", callback_data: "self-run:morning" },
        { text: "Evening", callback_data: "self-run:evening" },
      ],
    ],
  };
}

async function handleNikTelegramMessage(env, message) {
  const chatId = String(message?.chat?.id || "");
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

  if (isStatusCommand(message?.text)) {
    await telegramSend(env, "Loading Bilky status...");
    const requestId = String(message?.message_id || Date.now());
    const result = await dispatchStatusOnce(
      env,
      "nik",
      "nik",
      chatId,
      "client",
      requestId
    );

    if (!result.ok) {
      throw new Error(result.error || "status-dispatch-failed");
    }
    return;
  }

  if (isRunCommand(message?.text)) {
    if (!isWeekday(madridParts())) {
      await telegramSend(env, "Сегодня выходной. Запуск недоступен.");
      return;
    }

    await telegramSend(env, "What do you want to run?", {
      reply_markup: selfActionKeyboard(),
    });
  }
}

async function handleNikTelegramCallback(env, callback) {
  const chatId = String(callback?.message?.chat?.id || "");
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

  await telegramAnswer(env, callback.id);

  const data = String(callback?.data || "");
  if (!data.startsWith("self-run:")) return;

  const action = data.slice("self-run:".length);
  const result = await dispatchManualOnce(
    env,
    "nik",
    "nik",
    action,
    String(callback.id)
  );

  if (result.weekend) {
    await telegramSend(env, "Сегодня выходной. Запуск недоступен.");
    return;
  }

  if (result.nonWorkingDay) {
    await telegramSend(
      env,
      `Bilky for Nik: ${result.date} is a non-working day${result.reason ? ` (${result.reason})` : ""}. Run is blocked.`
    );
    return;
  }

  if (!result.ok) {
    await telegramSend(
      env,
      `Bilky for Nik: could not start the run. ${result.error || "Unknown error"}`
    );
    return;
  }

  const label = action === "morning" ? "Morning" : "Evening";
  await telegramSend(
    env,
    `Bilky for Nik: ${label} started. Automatic recovery is enabled (up to 15 attempts).`
  );
}

async function handleNikTelegramWebhook(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  const expectedSecret = await telegramWebhookSecret(env.TELEGRAM_BOT_TOKEN);

  if (!secret || secret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await request.json().catch(() => ({}));

  try {
    if (update.callback_query) {
      await handleNikTelegramCallback(env, update.callback_query);
    } else if (update.message) {
      await handleNikTelegramMessage(env, update.message);
    }
  } catch (error) {
    console.error(
      "Nik Telegram webhook error",
      String(error?.message || error).slice(0, 500)
    );
  }

  return new Response("OK", { status: 200 });
}

async function githubRequest(env, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bilky-v4.1-control-plane",
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

async function reserveDispatch(env, key, payload, ttl = STATE_TTL_SECONDS) {
  const existing = await env.BILKY_STATE.get(key);
  if (existing) {
    return { ok: true, reserved: false, duplicate: true };
  }

  await env.BILKY_STATE.put(
    key,
    JSON.stringify({
      state: "dispatching",
      reservedAt: new Date().toISOString(),
      ...payload,
    }),
    { expirationTtl: ttl }
  );

  return { ok: true, reserved: true, duplicate: false };
}

async function markDispatched(env, key, payload, ttl = STATE_TTL_SECONDS) {
  await env.BILKY_STATE.put(
    key,
    JSON.stringify({
      state: "dispatched",
      dispatchedAt: new Date().toISOString(),
      ...payload,
    }),
    { expirationTtl: ttl }
  );
}

async function releaseReservation(env, key) {
  await env.BILKY_STATE.delete(key);
}

function workshiftInputs(client, action, mode) {
  return {
    client_id: client.id,
    client_label: client.label,
    airtop_profile: client.airtopProfile,
    github_environment: client.githubEnvironment,
    action,
    mode,
  };
}

async function dispatchScheduledOnce(env, client, date, action) {
  const nonWorkingDay = await getNonWorkingDay(env, client.id, date);
  if (nonWorkingDay) {
    console.log(
      `Skipping scheduled ${client.id} ${date} ${action}: non-working day (${nonWorkingDay.reason || "no reason"})`
    );
    return {
      ok: true,
      dispatched: false,
      nonWorkingDay: true,
      date,
      reason: nonWorkingDay.reason || "",
    };
  }

  const key = `v4.1:scheduled:${client.id}:${date}:${action}`;
  const payload = { client: client.id, date, action, mode: "scheduled" };
  const reservation = await reserveDispatch(env, key, payload);

  if (!reservation.reserved) return reservation;

  try {
    await dispatchWorkflow(
      env,
      WORKSHIFT_WORKFLOW,
      workshiftInputs(client, action, "scheduled")
    );
    await markDispatched(env, key, payload);
    return { ok: true, dispatched: true, duplicate: false };
  } catch (error) {
    await releaseReservation(env, key);
    throw error;
  }
}

async function dispatchManualOnce(env, role, clientId, action, requestId) {
  const now = madridParts();

  if (!isWeekday(now)) {
    return { ok: true, dispatched: false, weekend: true };
  }

  if (!["morning", "evening"].includes(action)) {
    return { ok: false, error: "invalid-action" };
  }

  if (!allowed(role, "run", clientId)) {
    return { ok: false, error: "forbidden" };
  }

  const client = clientById(clientId);
  if (!client) {
    return { ok: false, error: "client-not-enabled" };
  }

  const date = madridDate(now);
  const nonWorkingDay = await getNonWorkingDay(env, client.id, date);
  if (nonWorkingDay) {
    return {
      ok: true,
      dispatched: false,
      nonWorkingDay: true,
      date,
      reason: nonWorkingDay.reason || "",
    };
  }

  const key = `v4.1:manual:${client.id}:${requestId}`;
  const payload = {
    client: client.id,
    action,
    mode: "manual",
    requestId,
    role,
  };
  const reservation = await reserveDispatch(env, key, payload);

  if (!reservation.reserved) return reservation;

  try {
    await dispatchWorkflow(
      env,
      WORKSHIFT_WORKFLOW,
      workshiftInputs(client, action, "manual")
    );
    await markDispatched(env, key, payload);
    return { ok: true, dispatched: true, duplicate: false };
  } catch (error) {
    await releaseReservation(env, key);
    throw error;
  }
}

async function dispatchStatusOnce(
  env,
  role,
  clientId,
  chatId,
  recipient,
  requestId
) {
  if (!allowed(role, "status", clientId)) {
    return { ok: false, error: "forbidden" };
  }

  const client = clientById(clientId);
  if (!client) {
    return { ok: false, error: "client-not-enabled" };
  }

  const nonWorkingDays = await getNonWorkingDays(env, client.id);

  if (!["client", "admin"].includes(recipient)) {
    return { ok: false, error: "invalid-recipient" };
  }

  const key = `v4.1:status:${client.id}:${requestId}`;
  const payload = {
    client: client.id,
    role,
    recipient,
    chatId: String(chatId),
    requestId,
  };
  const reservation = await reserveDispatch(env, key, payload, 86400);

  if (!reservation.reserved) return reservation;

  try {
    await dispatchWorkflow(env, STATUS_WORKFLOW, {
      client_id: client.id,
      client_label: client.label,
      airtop_profile: client.airtopProfile,
      github_environment: client.githubEnvironment,
      recipient,
      chat_id: String(chatId),
      non_working_days_json: JSON.stringify(nonWorkingDays),
    });
    await markDispatched(env, key, payload, 86400);
    return { ok: true, dispatched: true, duplicate: false };
  } catch (error) {
    await releaseReservation(env, key);
    throw error;
  }
}

export default {
  async scheduled(controller, env) {
    const parts = madridParts(new Date(controller.scheduledTime));
    if (!isWeekday(parts)) return;

    const date = madridDate(parts);

    for (const client of Object.values(CLIENTS)) {
      if (!client.enabled || !client.scheduled) continue;

      for (const action of ["morning", "evening"]) {
        if (!inDispatchWindow(parts, action)) continue;

        try {
          await dispatchScheduledOnce(env, client, date, action);
        } catch (error) {
          console.error(
            `Scheduled dispatch failed for ${client.id} ${date} ${action}`,
            String(error?.message || error).slice(0, 500)
          );
        }
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram") {
      return handleNikTelegramWebhook(request, env);
    }

    if (url.pathname === "/health") {
      return Response.json({
        service: "bilky-v4.1-control-plane",
        architecture: "v4.1",
        enabledClients: Object.values(CLIENTS)
          .filter((client) => client.enabled)
          .map((client) => client.id),
        workflow: WORKSHIFT_WORKFLOW,
        statusWorkflow: STATUS_WORKFLOW,
        retries: "3-cycles-x-5-inside-single-github-run",
        retryIntervalMinutes: 3,
        nonWorkingDays: "D1:non_working_days",
      });
    }

    if (!url.pathname.startsWith("/internal/")) {
      return new Response("bilky v4.1 control plane", { status: 200 });
    }

    // Internal actions are expected only through the Cloudflare service binding.
    // The synthetic hostname prevents direct public HTTP calls from dispatching jobs.
    if (!["nik-v4.internal", "bilky-v4.internal"].includes(url.hostname)) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const payload = await request.json().catch(() => ({}));

    if (url.pathname === "/internal/manual") {
      const result = await dispatchManualOnce(
        env,
        String(payload.role || ""),
        String(payload.client_id || ""),
        String(payload.action || ""),
        String(payload.request_id || "")
      );
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (url.pathname === "/internal/status") {
      const result = await dispatchStatusOnce(
        env,
        String(payload.role || ""),
        String(payload.client_id || ""),
        String(payload.chat_id || ""),
        String(payload.recipient || ""),
        String(payload.request_id || "")
      );
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    return new Response("Not found", { status: 404 });
  },
};
