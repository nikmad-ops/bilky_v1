import worker from "../cloudflare/bilky-v4.1-control-plane.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createEnv(nonWorkingRows = []) {
  const state = new Map();
  const dbCalls = [];

  return {
    env: {
      BILKY_STATE: {
        async get(key) {
          return state.get(key) || null;
        },
        async put(key, value) {
          state.set(key, value);
        },
        async delete(key) {
          state.delete(key);
        },
      },
      BILKY_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async first() {
                  dbCalls.push({ kind: "first", sql, params });
                  const [userId, date] = params;
                  return (
                    nonWorkingRows.find(
                      (row) => row.user_id === userId && row.date === date
                    ) || null
                  );
                },
                async all() {
                  dbCalls.push({ kind: "all", sql, params });
                  const [userId] = params;
                  return {
                    results: nonWorkingRows.filter(
                      (row) => row.user_id === userId
                    ),
                  };
                },
              };
            },
          };
        },
      },
      GITHUB_TOKEN: "test-token",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_CHAT_ID: "123",
    },
    dbCalls,
  };
}

const originalFetch = globalThis.fetch;
const githubCalls = [];

globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith("https://api.github.com/")) {
    githubCalls.push({
      url: String(url),
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
    });
    return new Response(null, { status: 204 });
  }

  throw new Error("Unexpected external fetch in offline test: " + url);
};

try {
  const holidays = [
    {
      user_id: "nik",
      date: "2026-10-09",
      reason: "Valencian Community Day",
    },
    {
      user_id: "alena",
      date: "2026-10-09",
      reason: "Valencian Community Day",
    },
    {
      user_id: "alena",
      date: "2026-10-12",
      reason: "National Day of Spain",
    },
  ];

  {
    githubCalls.length = 0;
    const { env } = createEnv(holidays);

    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-09T06:00:00Z") },
      env
    );

    assert(
      githubCalls.length === 0,
      "Non-working day must not dispatch any GitHub workshift workflow"
    );
  }

  {
    githubCalls.length = 0;
    const { env } = createEnv(holidays);

    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-08T06:00:00Z") },
      env
    );

    assert(
      githubCalls.length === 2,
      "Normal working day must dispatch Nik and Alena Morning jobs"
    );

    const clients = githubCalls
      .map((call) => call.body?.inputs?.client_id)
      .sort();

    assert(
      JSON.stringify(clients) === JSON.stringify(["alena", "nik"]),
      "Working-day dispatch must target Nik and Alena only before Irakli cutover"
    );
  }

  {
    githubCalls.length = 0;
    const { env } = createEnv(holidays);

    const response = await worker.fetch(
      new Request("https://nik-v4.internal/internal/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "admin",
          client_id: "alena",
          recipient: "admin",
          chat_id: "999",
          request_id: "status-test",
        }),
      }),
      env
    );

    assert(response.status === 200, "Internal Status request must succeed");
    assert(githubCalls.length === 1, "Status must dispatch exactly one workflow");

    const input = githubCalls[0].body?.inputs;
    const days = JSON.parse(input?.non_working_days_json || "[]");

    assert(
      days.some(
        (row) =>
          row.date === "2026-10-09" &&
          row.reason === "Valencian Community Day"
      ),
      "Status dispatch must include 9 October non-working day"
    );

    assert(
      days.some(
        (row) =>
          row.date === "2026-10-12" &&
          row.reason === "National Day of Spain"
      ),
      "Status dispatch must include 12 October non-working day"
    );
  }

  console.log("v4.1 non-working day offline tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
