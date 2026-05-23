const Sentry = require("@sentry/node");

const SENTRY_DSN = String(process.env.SENTRY_DSN || "").trim();
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE || "watch-party-server@local";
const SENTRY_TRACES_SAMPLE_RATE = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0);
const SENTRY_DEBUG = process.env.SENTRY_DEBUG === "true";

let sentryEnabled = false;

function initSentry() {
  if (!SENTRY_DSN) {
    console.log("Sentry disabled: SENTRY_DSN is not set.");
    return;
  }

  const tracesSampleRate = Number.isFinite(SENTRY_TRACES_SAMPLE_RATE)
    ? Math.max(0, Math.min(1, SENTRY_TRACES_SAMPLE_RATE))
    : 0;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    tracesSampleRate,
    debug: SENTRY_DEBUG,
  });

  sentryEnabled = true;
  console.log("Sentry enabled.");
}

function captureException(error, context = {}) {
  if (!sentryEnabled || !error) {
    return;
  }

  Sentry.withScope((scope) => {
    const tags = context.tags || {};
    const extras = context.extras || {};
    const user = context.user || null;

    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined && value !== null) {
        scope.setTag(key, String(value));
      }
    }

    for (const [key, value] of Object.entries(extras)) {
      if (value !== undefined && value !== null) {
        scope.setExtra(key, value);
      }
    }

    if (user && typeof user === "object") {
      scope.setUser(user);
    }

    if (context.level) {
      scope.setLevel(context.level);
    }

    Sentry.captureException(error);
  });
}

async function flushSentry(timeoutMs = 2000) {
  if (!sentryEnabled) {
    return true;
  }

  try {
    return await Sentry.flush(timeoutMs);
  } catch (flushError) {
    console.error("Sentry flush failed:", flushError);
    return false;
  }
}

function isSentryEnabled() {
  return sentryEnabled;
}

module.exports = {
  captureException,
  flushSentry,
  initSentry,
  isSentryEnabled,
};
