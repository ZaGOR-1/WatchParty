require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const { parseVideoUrl } = require("./utils/videoParser");
const { validateMp4Url } = require("./utils/mp4Probe");
const {
  getMetricsSnapshot,
  recordRoomCreated,
  recordRoomRemoved,
  recordSocketConnection,
  recordSocketDisconnect,
  recordSocketHandlerError,
} = require("./observability/metrics");
const {
  captureException,
  flushSentry,
  initSentry,
  isSentryEnabled,
} = require("./observability/sentry");
const {
  connectRoomsStore,
  disconnectRoomsStore,
  createRoom,
  getRoom,
  getRoomState,
  setPlaybackState,
  setSeekState,
  addPlaylistItem,
  removePlaylistItem,
  setCurrentPlaylistItem,
  advancePlaylist,
  upsertParticipant,
  removeParticipant,
  clearIdleRooms,
  setRoomControlMode,
} = require("./rooms");

const PORT = Number(process.env.PORT || 4000);
const ROOM_TTL_MINUTES = Number(process.env.ROOM_TTL_MINUTES || 30);
const PLAYLIST_MAX_ITEMS = Number(process.env.PLAYLIST_MAX_ITEMS || 50);
const MP4_PROBE_ENABLED = process.env.MP4_PROBE_ENABLED !== "false";
const METRICS_TOKEN = String(process.env.METRICS_TOKEN || "").trim();
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("CORS policy violation"));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
initSentry();

function isMetricsRequestAuthorized(request) {
  if (!METRICS_TOKEN) {
    return true;
  }

  const bearerHeader = String(request.headers.authorization || "").trim();
  const headerToken = String(request.headers["x-metrics-token"] || "").trim();
  const bearerToken = bearerHeader.toLowerCase().startsWith("bearer ")
    ? bearerHeader.slice(7).trim()
    : "";

  return headerToken === METRICS_TOKEN || bearerToken === METRICS_TOKEN;
}

async function parseAndValidateVideoUrl(rawVideoUrl) {
  const parsed = parseVideoUrl(rawVideoUrl);

  if (parsed.error) {
    const error = new Error(parsed.error);
    error.status = 400;
    throw error;
  }

  if (parsed.videoType === "mp4" && MP4_PROBE_ENABLED) {
    const probe = await validateMp4Url(parsed.normalizedUrl);

    if (!probe.ok) {
      const error = new Error(probe.message);
      error.status = 400;
      error.details = probe.details;
      throw error;
    }
  }

  return parsed;
}

app.get("/api/health", (request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/metrics", (request, response) => {
  if (!isMetricsRequestAuthorized(request)) {
    response.status(401).json({ message: "Неавторизований доступ до метрик." });
    return;
  }

  response.json(getMetricsSnapshot());
});

app.post("/api/rooms", async (request, response) => {
  try {
    const { videoUrl, videoUrls } = request.body || {};
    const urlsToParse = Array.isArray(videoUrls) ? videoUrls : [videoUrl];
    const normalizedRawUrls = urlsToParse
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    if (normalizedRawUrls.length === 0) {
      response.status(400).json({ message: "Передайте хоча б одне посилання на відео." });
      return;
    }

    if (normalizedRawUrls.length > PLAYLIST_MAX_ITEMS) {
      response.status(400).json({
        message: `У стартовому плейлисті можна передати максимум ${PLAYLIST_MAX_ITEMS} відео.`,
      });
      return;
    }

    const parsedVideos = [];

    for (const rawUrl of normalizedRawUrls) {
      const parsed = await parseAndValidateVideoUrl(rawUrl);
      parsedVideos.push(parsed);
    }

    const [firstVideo, ...restVideos] = parsedVideos;
    const room = await createRoom({
      videoUrl: firstVideo.normalizedUrl,
      videoType: firstVideo.videoType,
      videoId: firstVideo.videoId,
    });
    recordRoomCreated();

    for (const extraVideo of restVideos) {
      await addPlaylistItem(room.roomId, {
        videoUrl: extraVideo.normalizedUrl,
        videoType: extraVideo.videoType,
        videoId: extraVideo.videoId,
        addedBy: null,
      });
    }

    response.status(201).json({
      roomId: room.roomId,
      url: `/room/${room.roomId}`,
    });
  } catch (error) {
    console.error("POST /api/rooms error:", error);
    captureException(error, {
      tags: {
        area: "http",
        route: "POST /api/rooms",
      },
      extras: {
        bodyVideoUrl: request?.body?.videoUrl || null,
      },
    });
    response.status(error.status || 500).json({
      message: error.message || "Помилка сервера під час створення кімнати.",
      details: Array.isArray(error.details) ? error.details : [],
    });
  }
});

app.get("/api/rooms/:roomId", async (request, response) => {
  try {
    const room = await getRoom(request.params.roomId, { touchTtl: true });

    if (!room) {
      response.status(404).json({ message: "Кімнату не знайдено." });
      return;
    }

    response.json(getRoomState(room));
  } catch (error) {
    console.error("GET /api/rooms/:roomId error:", error);
    captureException(error, {
      tags: {
        area: "http",
        route: "GET /api/rooms/:roomId",
      },
      extras: {
        roomId: request.params.roomId || null,
      },
    });
    response.status(500).json({ message: "Помилка сервера під час завантаження кімнати." });
  }
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

function createPlaybackEventPayload(room) {
  const snapshot = getRoomState(room);

  return {
    roomId: snapshot.roomId,
    isPlaying: snapshot.isPlaying,
    currentTime: snapshot.currentTime,
    stateCurrentTime: snapshot.stateCurrentTime,
    updatedAt: snapshot.updatedAt,
    stateUpdatedAt: snapshot.stateUpdatedAt,
    serverNowMs: snapshot.serverNowMs,
  };
}

function createRoomBroadcastPayload(room, extra = {}) {
  return {
    ...getRoomState(room),
    ...extra,
  };
}

io.on("connection", (socket) => {
  recordSocketConnection();

  function withSocketError(eventName, handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        recordSocketHandlerError(eventName);
        console.error("Socket handler error:", error);
        const isClientError = Number(error?.status) >= 400 && Number(error?.status) < 500;

        if (!isClientError) {
          captureException(error, {
            tags: {
              area: "socket",
              event: eventName,
              roomId: socket.data.roomId || "none",
            },
            extras: {
              socketId: socket.id,
            },
            user: socket.data.nickname ? { username: socket.data.nickname } : null,
          });
        }

        socket.emit("roomError", {
          message: isClientError
            ? error.message
            : "Серверна помилка синхронізації. Спробуйте ще раз.",
        });
      }
    };
  }

  async function leaveCurrentRoom() {
    const currentRoomId = socket.data.roomId;

    if (!currentRoomId) {
      return;
    }

    socket.leave(currentRoomId);
    const { room, removedParticipant } = await removeParticipant(currentRoomId, socket.id);
    socket.data.roomId = null;
    socket.data.nickname = null;

    if (room) {
      const snapshot = getRoomState(room);
      io.to(currentRoomId).emit("userLeft", {
        usersCount: snapshot.usersCount,
        participants: snapshot.participants,
        hostSocketId: snapshot.hostSocketId,
        hostNickname: snapshot.hostNickname,
        nickname: removedParticipant?.nickname || null,
      });
    }
  }

  function getTargetRoomId(inputRoomId) {
    return inputRoomId || socket.data.roomId || null;
  }

  async function getRoomForAction(inputRoomId) {
    const targetRoomId = getTargetRoomId(inputRoomId);

    if (!targetRoomId) {
      socket.emit("roomError", { message: "Не передано roomId." });
      return {
        room: null,
        targetRoomId: null,
      };
    }

    const room = await getRoom(targetRoomId, { touchTtl: true });

    if (!room) {
      socket.emit("roomError", { message: "Кімнату не знайдено." });
      return {
        room: null,
        targetRoomId,
      };
    }

    return {
      room,
      targetRoomId,
    };
  }

  function isHostControlledRoom(room) {
    return String(room?.controlMode || "all") === "host";
  }

  function isSocketHost(room) {
    return Boolean(room?.hostSocketId) && room.hostSocketId === socket.id;
  }

  function rejectHostOnlyAction(room) {
    const hostNickname = room?.hostNickname || room?.participants?.find(
      (participant) => participant.socketId === room.hostSocketId
    )?.nickname;
    const hostLabel = hostNickname ? ` (${hostNickname})` : "";

    socket.emit("roomError", {
      message: `Зараз увімкнено режим "керує тільки хост". Доступно лише хосту${hostLabel}.`,
    });
    socket.emit("syncResponse", {
      ...getRoomState(room),
      reason: "host_only_rejected",
    });
  }

  function ensureCanControl(room) {
    if (!room) {
      return false;
    }

    if (!isHostControlledRoom(room)) {
      return true;
    }

    if (isSocketHost(room)) {
      return true;
    }

    rejectHostOnlyAction(room);
    return false;
  }

  socket.on(
    "joinRoom",
    withSocketError("joinRoom", async ({ roomId, nickname } = {}) => {
      if (!roomId) {
        socket.emit("roomError", { message: "Не передано roomId." });
        return;
      }

      const room = await getRoom(roomId, { touchTtl: true });

      if (!room) {
        socket.emit("roomError", { message: "Кімнату не знайдено." });
        return;
      }

      if (socket.data.roomId && socket.data.roomId !== roomId) {
        await leaveCurrentRoom();
      }

      if (socket.data.roomId === roomId) {
        const updatedRoom = await upsertParticipant(roomId, {
          socketId: socket.id,
          nickname,
        });

        if (!updatedRoom) {
          socket.emit("roomError", { message: "Не вдалося оновити учасника кімнати." });
          return;
        }

        const snapshot = getRoomState(updatedRoom);
        const currentParticipant = snapshot.participants.find(
          (participant) => participant.socketId === socket.id
        );
        socket.data.nickname = currentParticipant?.nickname || null;
        socket.emit("roomState", snapshot);
        socket.to(roomId).emit("userJoined", {
          usersCount: snapshot.usersCount,
          participants: snapshot.participants,
          hostSocketId: snapshot.hostSocketId,
          hostNickname: snapshot.hostNickname,
          nickname: socket.data.nickname,
        });
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      const updatedRoom = await upsertParticipant(roomId, {
        socketId: socket.id,
        nickname,
      });

      if (!updatedRoom) {
        socket.emit("roomError", { message: "Не вдалося приєднатися до кімнати." });
        return;
      }

      const snapshot = getRoomState(updatedRoom);
      const currentParticipant = snapshot.participants.find(
        (participant) => participant.socketId === socket.id
      );
      socket.data.nickname = currentParticipant?.nickname || null;
      socket.emit("roomState", snapshot);
      socket.to(roomId).emit("userJoined", {
        usersCount: snapshot.usersCount,
        participants: snapshot.participants,
        hostSocketId: snapshot.hostSocketId,
        hostNickname: snapshot.hostNickname,
        nickname: socket.data.nickname,
      });
    })
  );

  socket.on(
    "setControlMode",
    withSocketError("setControlMode", async ({ roomId, controlMode } = {}) => {
      const { room, targetRoomId } = await getRoomForAction(roomId);

      if (!room || !targetRoomId) {
        return;
      }

      if (!isSocketHost(room)) {
        socket.emit("roomError", {
          message: "Змінювати режим керування може тільки хост.",
        });
        return;
      }

      const safeControlMode = String(controlMode || "").trim().toLowerCase() === "host"
        ? "host"
        : "all";
      const updatedRoom = await setRoomControlMode(targetRoomId, safeControlMode);

      if (!updatedRoom) {
        socket.emit("roomError", {
          message: "Не вдалося оновити режим керування кімнатою.",
        });
        return;
      }

      io.to(targetRoomId).emit("roomState", getRoomState(updatedRoom));
    })
  );

  socket.on(
    "play",
    withSocketError("play", async ({ roomId, currentTime } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId || !ensureCanControl(roomBefore)) {
        return;
      }

      const room = await setPlaybackState(targetRoomId, { isPlaying: true, currentTime });

      if (!room) {
        return;
      }

      socket.to(targetRoomId).emit("play", createPlaybackEventPayload(room));
    })
  );

  socket.on(
    "pause",
    withSocketError("pause", async ({ roomId, currentTime } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId || !ensureCanControl(roomBefore)) {
        return;
      }

      const room = await setPlaybackState(targetRoomId, { isPlaying: false, currentTime });

      if (!room) {
        return;
      }

      socket.to(targetRoomId).emit("pause", createPlaybackEventPayload(room));
    })
  );

  socket.on(
    "seek",
    withSocketError("seek", async ({ roomId, currentTime } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId || !ensureCanControl(roomBefore)) {
        return;
      }

      const room = await setSeekState(targetRoomId, currentTime);

      if (!room) {
        return;
      }

      socket.to(targetRoomId).emit("seek", createPlaybackEventPayload(room));
    })
  );

  socket.on(
    "addToPlaylist",
    withSocketError("addToPlaylist", async ({ roomId, videoUrl } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId) {
        return;
      }

      if (!ensureCanControl(roomBefore)) {
        return;
      }

      if ((roomBefore.playlist || []).length >= PLAYLIST_MAX_ITEMS) {
        socket.emit("roomError", {
          message: `Ліміт плейлиста: максимум ${PLAYLIST_MAX_ITEMS} відео.`,
        });
        return;
      }

      const parsed = await parseAndValidateVideoUrl(videoUrl);
      const result = await addPlaylistItem(targetRoomId, {
        videoUrl: parsed.normalizedUrl,
        videoType: parsed.videoType,
        videoId: parsed.videoId,
        addedBy: socket.data.nickname || null,
      });

      if (!result.room) {
        socket.emit("roomError", { message: "Не вдалося додати відео у плейлист." });
        return;
      }

      io.to(targetRoomId).emit(
        "playlistUpdated",
        createRoomBroadcastPayload(result.room, {
          action: "added",
          item: result.item,
        })
      );
    })
  );

  socket.on(
    "removeFromPlaylist",
    withSocketError("removeFromPlaylist", async ({ roomId, itemId } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId) {
        return;
      }

      if (!ensureCanControl(roomBefore)) {
        return;
      }

      const result = await removePlaylistItem(targetRoomId, itemId);

      if (result.blocked) {
        socket.emit("roomError", {
          message: "Не можна видалити останнє відео з плейлиста.",
        });
        return;
      }

      if (!result.room) {
        socket.emit("roomError", { message: "Не вдалося оновити плейлист." });
        return;
      }

      if (!result.removedItem) {
        socket.emit("roomError", { message: "Відео для видалення не знайдено у плейлисті." });
        return;
      }

      io.to(targetRoomId).emit(
        "playlistUpdated",
        createRoomBroadcastPayload(result.room, {
          action: "removed",
          item: result.removedItem,
        })
      );
    })
  );

  socket.on(
    "setCurrentPlaylistItem",
    withSocketError("setCurrentPlaylistItem", async ({ roomId, itemId } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId) {
        return;
      }

      if (!ensureCanControl(roomBefore)) {
        return;
      }

      const result = await setCurrentPlaylistItem(targetRoomId, itemId, { autoplay: true });

      if (!result.room || !result.changed) {
        socket.emit("roomError", { message: "Не вдалося перемкнути відео." });
        return;
      }

      io.to(targetRoomId).emit(
        "playlistUpdated",
        createRoomBroadcastPayload(result.room, {
          action: "selected",
          itemId,
        })
      );
    })
  );

  socket.on(
    "videoEnded",
    withSocketError("videoEnded", async ({ roomId, itemId } = {}) => {
      const { room: roomBefore, targetRoomId } = await getRoomForAction(roomId);

      if (!roomBefore || !targetRoomId) {
        return;
      }

      if (!ensureCanControl(roomBefore)) {
        return;
      }

      const result = await advancePlaylist(targetRoomId, {
        expectedItemId: itemId,
      });

      if (!result.room) {
        return;
      }

      if (result.changed) {
        io.to(targetRoomId).emit(
          "playlistAdvanced",
          createRoomBroadcastPayload(result.room, {
            reason: "auto_next",
          })
        );
        return;
      }

      if (result.reason === "last_item") {
        io.to(targetRoomId).emit(
          "playlistAdvanced",
          createRoomBroadcastPayload(result.room, {
            reason: "playlist_finished",
          })
        );
      }
    })
  );

  socket.on(
    "syncRequest",
    withSocketError("syncRequest", async ({ roomId, reason } = {}) => {
      const targetRoomId = roomId || socket.data.roomId;

      if (!targetRoomId) {
        return;
      }

      const room = await getRoom(targetRoomId, { touchTtl: true });

      if (!room) {
        socket.emit("roomError", { message: "Кімнату не знайдено." });
        return;
      }

      socket.emit("syncResponse", {
        ...getRoomState(room),
        reason: reason || "manual",
      });
    })
  );

  socket.on("timeSync", ({ clientSentAt } = {}, callback) => {
    const payload = {
      clientSentAt: Number(clientSentAt) || null,
      serverNowMs: Date.now(),
    };

    if (typeof callback === "function") {
      callback(payload);
      return;
    }

    socket.emit("timeSync", payload);
  });

  socket.on("disconnect", (reason) => {
    recordSocketDisconnect(reason);

    void leaveCurrentRoom().catch((error) => {
      console.error("Failed to leave room on disconnect:", error);
      captureException(error, {
        tags: {
          area: "socket",
          event: "disconnect_leaveCurrentRoom",
          reason: reason || "unknown",
        },
        extras: {
          socketId: socket.id,
        },
      });
    });
  });
});

setInterval(() => {
  void clearIdleRooms(ROOM_TTL_MINUTES * 60 * 1000)
    .then((result) => {
      const removedRooms = Array.isArray(result?.removedRooms) ? result.removedRooms : [];

      for (const removedRoom of removedRooms) {
        recordRoomRemoved(removedRoom);
      }
    })
    .catch((error) => {
      console.error("Room cleanup error:", error);
      captureException(error, {
        tags: {
          area: "background_job",
          event: "clearIdleRooms",
        },
      });
    });
}, 60 * 1000).unref();

async function startServer() {
  await connectRoomsStore();

  server.listen(PORT, () => {
    console.log(`Watch Party backend listening on port ${PORT}`);
    if (isSentryEnabled()) {
      console.log("Sentry telemetry is active.");
    }
  });
}

async function shutdownServer() {
  try {
    await flushSentry(2000);
    await disconnectRoomsStore();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  void shutdownServer();
});

process.on("SIGTERM", () => {
  void shutdownServer();
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  captureException(error, {
    tags: {
      area: "process",
      event: "uncaughtException",
    },
    level: "fatal",
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  const rejectionError = reason instanceof Error ? reason : new Error(String(reason));
  captureException(rejectionError, {
    tags: {
      area: "process",
      event: "unhandledRejection",
    },
    level: "error",
  });
});

startServer().catch((error) => {
  console.error("Failed to start backend:", error);
  captureException(error, {
    tags: {
      area: "process",
      event: "startServer",
    },
    level: "fatal",
  });
  process.exit(1);
});
