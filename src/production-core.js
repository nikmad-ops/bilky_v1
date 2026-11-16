  let sessionId = null;
  let browser = null;
  let context = null;
  let page = null;
  const captchaEvents = [];
  const recentNetwork = [];

  function safeUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return "";
    }
  }
  let sessionReadyAt = 0;
  let sessionDeadline = 0;

  async function connect() {
    let cdpWsUrl = "";
    let connectOptions = {};

    if (provider === "airtop") {
      log(`Creating Airtop session. attempt=${attempt}/5 solveCaptcha=true proxy=ES sticky=true`);

      const session = await airtop.sessions.create({
        configuration: {
          solveCaptcha: true,
          proxy: {
            country: "ES",
            sticky: true,
          },
          timeoutMinutes: 1,
          profileName: AIRTOP_PROFILE_NAME,
          persistProfile: true,
        },
      });

      sessionId = session.data.id;

      if (!session.data.cdpWsUrl) {
        throw new Error("Airtop session did not return cdpWsUrl");
      }

      cdpWsUrl = session.data.cdpWsUrl;
      connectOptions = {
        headers: {
          authorization: `Bearer ${airtopApiKey}`,
        },
        timeout: 120000,
      };

      sessionReadyAt = Date.now();
      sessionDeadline = sessionReadyAt + AIRTOP_SESSION_BUDGET_MS;

      log(
        `Airtop session ready: ${sessionId}; budget=${provider === "scrapeless" ? SCRAPELESS_SESSION_BUDGET_MS : AIRTOP_SESSION_BUDGET_MS}ms profile=${AIRTOP_PROFILE_NAME}`
      );

      try {
        await airtop.sessions.onCaptchaEvent(sessionId, (event) => {
          const status = event?.status || "unknown";
          const type = event?.type || "unknown";
          const duration = event?.duration ?? "n/a";
          const safeEvent = {
            at: new Date().toISOString(),
            status,
            type,
            durationMs:
              typeof event?.duration === "number" ? event.duration : null,
            solved: event?.solved === true,
          };
          captchaEvents.push(safeEvent);

          log(`CAPTCHA event: status=${status} type=${type} durationMs=${duration}`);
          fs.writeFileSync(
            `${diagnosticsDir}/captcha-events.json`,
            JSON.stringify(captchaEvents, null, 2),
            "utf8"
          );
        });
        log("Airtop CAPTCHA event logging enabled.");
      } catch (error) {
        log(
          `Airtop CAPTCHA event logging unavailable: ${String(error?.message || error)
            .split("\n")[0]
            .slice(0, 200)}`
        );
      }
    } else {
      const sessionName = `bilky-${process.env.CLIENT_ID || "client"}-${Date.now()}`;
      const params = new URLSearchParams({
        token: scrapelessApiKey,
        sessionTTL: "60",
        sessionName,
        sessionRecording: "true",
        proxyCountry: "ES",
      });

      cdpWsUrl = `wss://browser.scrapeless.com/api/v2/browser?${params.toString()}`;
      connectOptions = { timeout: 20000 };

      sessionId = sessionName;

      log(
        `Creating Scrapeless session. attempt=${attempt}/5 proxy=ES recording=true budget=${SCRAPELESS_SESSION_BUDGET_MS}ms`
      );
    }

    const connectStartedAt = Date.now();
    browser = await chromium.connectOverCDP(cdpWsUrl, connectOptions);

    if (provider === "scrapeless") {
      sessionReadyAt = Date.now();
      sessionDeadline = sessionReadyAt + SCRAPELESS_SESSION_BUDGET_MS;
      log(
        `Scrapeless session ready: ${sessionId}; connectMs=${sessionReadyAt - connectStartedAt}; budget=${SCRAPELESS_SESSION_BUDGET_MS}ms`
      );
    }

    context = browser.contexts()[0];
    if (!context) {
      throw new Error(`${provider} default browser context not found`);
    }

    page = context.pages()[0] || (await context.newPage());

    page.on("request", (request) => {