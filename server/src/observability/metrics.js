const DEFAULT_METRICS_WINDOW_MS = 5 * 60 * 1000;
const MAX_WINDOW_EVENTS = 20000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function clampToNow(timestamp, now) {
  const parsed = Number(timestamp);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return now;
  }

  return Math.min(parsed, now);
}

const windowMs = parsePositiveInteger(process.env.METRICS_WINDOW_MS, DEFAULT_METRICS_WINDOW_MS);

const metricsState = {
  startedAt: Date.now(),
  windowMs,
  socket: {
    connectionsTotal: 0,
    disconnectsTotal: 0,
    errorsTotal: 0,
    handlerErrorsByEvent: {},
    disconnectReasons: {},
    connectionEvents: [],
    disconnectEvents: [],
  },
  rooms: {
    createdTotal: 0,
    removedTotal: 0,
    removedByReason: {},
    lifetimeMs: {
      count: 0,
      total: 0,
      min: null,
      max: null,
      avg: 0,
      last: null,
      lastRoomId: null,
      lastReason: null,
      lastRemovedAt: null,
    },
  },
};

function pushWindowEvent(collection, timestamp) {
  collection.push(timestamp);

  if (collection.length > MAX_WINDOW_EVENTS) {
    collection.splice(0, collection.length - MAX_WINDOW_EVENTS);
  }
}

function pruneWindowEvents(collection, cutoffTs) {
  let removeCount = 0;

  while (removeCount < collection.length && collection[removeCount] < cutoffTs) {
    removeCount += 1;
  }

  if (removeCount > 0) {
    collection.splice(0, removeCount);
  }
}

function pruneRollingWindow(now = Date.now()) {
  const cutoffTs = now - metricsState.windowMs;
  pruneWindowEvents(metricsState.socket.connectionEvents, cutoffTs);
  pruneWindowEvents(metricsState.socket.disconnectEvents, cutoffTs);
}

function normalizeCounterKey(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return normalized || fallback;
}

function incrementCounter(counterObject, key) {
  counterObject[key] = (counterObject[key] || 0) + 1;
}

function recordSocketConnection() {
  const now = Date.now();
  metricsState.socket.connectionsTotal += 1;
  pushWindowEvent(metricsState.socket.connectionEvents, now);
  pruneRollingWindow(now);
}

function recordSocketDisconnect(reason) {
  const now = Date.now();
  metricsState.socket.disconnectsTotal += 1;
  pushWindowEvent(metricsState.socket.disconnectEvents, now);
  incrementCounter(
    metricsState.socket.disconnectReasons,
    normalizeCounterKey(reason, "unknown_disconnect_reason")
  );
  pruneRollingWindow(now);
}

function recordSocketHandlerError(eventName) {
  metricsState.socket.errorsTotal += 1;
  incrementCounter(
    metricsState.socket.handlerErrorsByEvent,
    normalizeCounterKey(eventName, "unknown_event")
  );
}

function recordRoomCreated() {
  metricsState.rooms.createdTotal += 1;
}

function recordRoomRemoved({ roomId, createdAt, removedAt, reason } = {}) {
  const now = Date.now();
  const endedAt = clampToNow(removedAt, now);
  const startedAt = clampToNow(createdAt, endedAt);
  const lifetimeMs = Math.max(0, endedAt - startedAt);
  const safeReason = normalizeCounterKey(reason, "unknown");

  metricsState.rooms.removedTotal += 1;
  incrementCounter(metricsState.rooms.removedByReason, safeReason);

  const lifetimeState = metricsState.rooms.lifetimeMs;
  lifetimeState.count += 1;
  lifetimeState.total += lifetimeMs;
  lifetimeState.avg = lifetimeState.total / lifetimeState.count;
  lifetimeState.min = lifetimeState.min === null ? lifetimeMs : Math.min(lifetimeState.min, lifetimeMs);
  lifetimeState.max = lifetimeState.max === null ? lifetimeMs : Math.max(lifetimeState.max, lifetimeMs);
  lifetimeState.last = lifetimeMs;
  lifetimeState.lastRoomId = roomId || null;
  lifetimeState.lastReason = safeReason;
  lifetimeState.lastRemovedAt = endedAt;
}

function toSeconds(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return null;
  }

  return Number((milliseconds / 1000).toFixed(3));
}

function getMetricsSnapshot() {
  const now = Date.now();
  pruneRollingWindow(now);

  const connectionsInWindow = metricsState.socket.connectionEvents.length;
  const disconnectsInWindow = metricsState.socket.disconnectEvents.length;
  const windowMinutes = metricsState.windowMs / (60 * 1000);
  const disconnectRatio =
    connectionsInWindow > 0 ? disconnectsInWindow / connectionsInWindow : null;

  return {
    generatedAt: new Date(now).toISOString(),
    startedAt: new Date(metricsState.startedAt).toISOString(),
    uptimeSec: toSeconds(now - metricsState.startedAt),
    rollingWindowSec: Math.floor(metricsState.windowMs / 1000),
    socket: {
      connectionsTotal: metricsState.socket.connectionsTotal,
      disconnectsTotal: metricsState.socket.disconnectsTotal,
      errorsTotal: metricsState.socket.errorsTotal,
      handlerErrorsByEvent: { ...metricsState.socket.handlerErrorsByEvent },
      disconnectReasons: { ...metricsState.socket.disconnectReasons },
      activeConnections:
        metricsState.socket.connectionsTotal - metricsState.socket.disconnectsTotal,
      rollingWindow: {
        connections: connectionsInWindow,
        disconnects: disconnectsInWindow,
        disconnectRatio:
          disconnectRatio === null ? null : Number(disconnectRatio.toFixed(4)),
        disconnectPercent:
          disconnectRatio === null ? null : Number((disconnectRatio * 100).toFixed(2)),
        disconnectsPerMinute: Number((disconnectsInWindow / windowMinutes).toFixed(3)),
      },
    },
    rooms: {
      createdTotal: metricsState.rooms.createdTotal,
      removedTotal: metricsState.rooms.removedTotal,
      removedByReason: { ...metricsState.rooms.removedByReason },
      lifetimeSec: {
        count: metricsState.rooms.lifetimeMs.count,
        avg: toSeconds(metricsState.rooms.lifetimeMs.avg),
        min: toSeconds(metricsState.rooms.lifetimeMs.min),
        max: toSeconds(metricsState.rooms.lifetimeMs.max),
        last: toSeconds(metricsState.rooms.lifetimeMs.last),
        lastRoomId: metricsState.rooms.lifetimeMs.lastRoomId,
        lastReason: metricsState.rooms.lifetimeMs.lastReason,
        lastRemovedAt: metricsState.rooms.lifetimeMs.lastRemovedAt
          ? new Date(metricsState.rooms.lifetimeMs.lastRemovedAt).toISOString()
          : null,
      },
    },
  };
}

module.exports = {
  getMetricsSnapshot,
  recordRoomCreated,
  recordRoomRemoved,
  recordSocketConnection,
  recordSocketDisconnect,
  recordSocketHandlerError,
};
