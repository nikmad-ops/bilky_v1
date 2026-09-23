import fs from "node:fs";
import {
  TIMEZONE,
  createBilkyCore,
  formatDuration,
  log,
  minutesFromTime,
} from "./bilky-core.js";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  REQUEST_CHAT_ID,
  TELEGRAM_CHAT_ID,
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  REQUEST_CHAT_ID,
  TELEGRAM_CHAT_ID,
})) {
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`
    );
  }
}

if (
  String(
    REQUEST_CHAT_ID
  ) !==
  String(
    TELEGRAM_CHAT_ID
  )
) {
  throw new Error(
    "Unauthorized Telegram chat_id"
  );
}

function madridParts(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          TIMEZONE,
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit",
        hour:
          "2-digit",
        minute:
          "2-digit",
        hour12:
          false,
      }
    ).formatToParts(
      date
    );

  return Object.fromEntries(
    parts.map(
      ({
        type,
        value,
      }) => [
        type,
        value,
      ]
    )
  );
}

function ymdFromParts(p) {
  return (
    `${p.year}-${p.month}-${p.day}`
  );
}

function utcNoonFromYmd(
  ymd
) {
  const [y, m, d] =
    ymd
      .split("-")
      .map(Number);

  return new Date(
    Date.UTC(
      y,
      m - 1,
      d,
      12,
      0,
      0
    )
  );
}

function ymdFromDateUtc(
  date
) {
  return date
    .toISOString()
    .slice(
      0,
      10
    );
}

function addDays(
  ymd,
  days
) {
  const date =
    utcNoonFromYmd(
      ymd
    );

  date.setUTCDate(
    date.getUTCDate() +
    days
  );

  return ymdFromDateUtc(
    date
  );
}

function isoWeekInfo(
  ymd
) {
  const date =
    utcNoonFromYmd(
      ymd
    );

  const day =
    date.getUTCDay() ||
    7;

  const monday =
    new Date(date);

  monday.setUTCDate(
    date.getUTCDate() -
    day +
    1
  );

  const thursday =
    new Date(date);

  thursday.setUTCDate(
    date.getUTCDate() +
    4 -
    day
  );

  const yearStart =
    new Date(
      Date.UTC(
        thursday.getUTCFullYear(),
        0,
        1,
        12
      )
    );

  const week =
    Math.ceil(
      (
        (
          thursday -
          yearStart
        ) /
        86400000 +
        1
      ) /
      7
    );

  return {
    week,
    monday:
      ymdFromDateUtc(
        monday
      ),
    friday:
      addDays(
        ymdFromDateUtc(
          monday
        ),
        4
      ),
  };
}

function ordinal(n) {
  const mod100 =
    n %
    100;

  if (
    mod100 >=
      11 &&
    mod100 <=
      13
  ) {
    return `${n}th`;
  }

  if (
    n % 10 ===
    1
  ) {
    return `${n}st`;
  }

  if (
    n % 10 ===
    2
  ) {
    return `${n}nd`;
  }

  if (
    n % 10 ===
    3
  ) {
    return `${n}rd`;
  }

  return `${n}th`;
}

function dayMonth(
  ymd
) {
  const [, m, d] =
    ymd.split("-");

  return `${d}/${m}`;
}

function monthName(
  month
) {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][
    Number(
      month
    ) -
    1
  ];
}

function weekRangeLabel(
  monday,
  friday
) {
  const [y1, m1, d1] =
    monday.split("-");

  const [y2, m2, d2] =
    friday.split("-");

  if (
    y1 === y2 &&
    m1 === m2
  ) {
    return (
      `${Number(d1)}-${Number(d2)} ${monthName(m1)} ${y1}`
    );
  }

  return (
    `${Number(d1)} ${monthName(m1)} - ${Number(d2)} ${monthName(m2)} ${y2}`
  );
}

function durationMinutes(
  startTime,
  endTime
) {
  const start =
    minutesFromTime(
      startTime
    );

  const end =
    minutesFromTime(
      endTime
    );

  if (
    start == null ||
    end == null ||
    end < start
  ) {
    return null;
  }

  return end - start;
}

function shortTime(
  time
) {
  return time
    ? time.slice(
        0,
        5
      )
    : null;
}

function compareYmd(
  a,
  b
) {
  return a.localeCompare(
    b
  );
}

function currentMadridMinutes() {
  const p =
    madridParts();

  return (
    Number(
      p.hour
    ) *
      60 +
    Number(
      p.minute
    )
  );
}

function classifyDay(
  date,
  state,
  today,
  nowMinutes
) {
  const label =
    dayMonth(
      date
    );

  const relation =
    compareYmd(
      date,
      today
    );

  if (
    !state.exists
  ) {
    if (
      relation >
      0
    ) {
      return {
        line:
          `⚪ ${label}: wait`,
        total: 0,
      };
    }

    return {
      line:
        `❌ ${label}: ERROR: ${state.error || "day data unavailable"}`,
      total: 0,
    };
  }

  const morning =
    shortTime(
      state.morning.fact
    );

  const evening =
    shortTime(
      state.evening.fact
    );

  const duration =
    durationMinutes(
      state.morning.fact,
      state.evening.fact
    );

  if (
    relation >
    0
  ) {
    return {
      line:
        `⚪ ${label}: wait`,
      total: 0,
    };
  }

  if (
    !morning &&
    evening
  ) {
    return {
      line:
        `❌ ${label}: ERROR: morning fact missing; evening=${evening}`,
      total: 0,
    };
  }

  if (
    !morning
  ) {
    if (
      relation ===
        0 &&
      nowMinutes <
        8 *
          60 +
          30
    ) {
      return {
        line:
          `⚪ ${label}: wait`,
        total: 0,
      };
    }

    return {
      line:
        `❌ ${label}: ERROR: morning fact missing`,
      total: 0,
    };
  }

  if (
    !evening
  ) {
    if (
      relation ===
        0 &&
      nowMinutes <=
        18 *
          60 +
          30
    ) {
      return {
        line:
          `🟡 ${label}: ${morning}, wait`,
        total: 0,
      };
    }

    return {
      line:
        `❌ ${label}: ${morning}, ERROR: evening fact missing`,
      total: 0,
    };
  }

  if (
    duration == null
  ) {
    return {
      line:
        `❌ ${label}: ${morning}, ${evening}, ERROR: invalid DAY interval`,
      total: 0,
    };
  }

  const day =
    formatDuration(
      duration
    );

  if (
    !state.signed
  ) {
    return {
      line:
        `⚠️ ${label}: ${morning}, ${evening}, NOT SIGNED, DAY ${day}`,
      total: 0,
    };
  }

  return {
    line:
      `✅ ${label}: ${morning}, ${evening}, Signed, DAY ${day}`,
    total:
      duration,
  };
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

async function buildStatus({
  page,
  setStage,
}) {
  const nowParts =
    madridParts();

  const today =
    ymdFromParts(
      nowParts
    );

  const nowMinutes =
    currentMadridMinutes();

  const {
    week,
    monday,
    friday,
  } =
    isoWeekInfo(
      today
    );

  const dates =
    Array.from(
      {
        length: 5,
      },
      (_, i) =>
        addDays(
          monday,
          i
        )
    );

  setStage(
    "validate-current-day"
  );

  await bilky.readDayState(
    page,
    today
  );

  const lines =
    [];

  let totalMinutes =
    0;

  for (
    const date of dates
  ) {
    setStage(
      `read-status-${date}`
    );

    const state =
      await bilky.readDayState(
        page,
        date,
        {
          allowMissing:
            true,
        }
      );

    const classified =
      classifyDay(
        date,
        state,
        today,
        nowMinutes
      );

    lines.push(
      classified.line
    );

    totalMinutes +=
      classified.total;
  }

  return [
    `📋 Bilky — ${ordinal(week)} week ${weekRangeLabel(monday, friday)}`,
    "",
    ...lines,
    "",
    `Total week = ${formatDuration(totalMinutes)}`,
  ].join(
    "\n"
  );
}

async function main() {
  const report =
    await bilky.runWithRetries(
      "Bilky status",
      buildStatus
    );

  fs.writeFileSync(
    "status-result.txt",
    report,
    "utf8"
  );

  log(
    "STATUS SUCCESS"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    try {
      fs.writeFileSync(
        "status-error.txt",
        String(error?.cause?.message || error?.message || error || "Unknown error")
          .split("\n")[0]
          .slice(0, 300),
        "utf8"
      );
    } catch {}

    console.error(error);
    process.exit(1);
  });
