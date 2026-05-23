require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const { parseVideoUrl } = require("./utils/videoParser");
const { validateMp4Url } = require("./utils/mp4Probe");
const {
  createRoom,
  getRoom,
  getRoomState,
  setPlaybackState,
  setSeekState,
  incrementUsers,
  decrementUsers,
  clearIdleRooms,
} = require("./rooms");

const PORT = Number(process.env.PORT || 4000);
const ROOM_TTL_MINUTES = Number(process.env.ROOM_TTL_MINUTES || 30);
const MP4_PROBE_ENABLED = process.env.MP4_PROBE_ENABLED !== "false";
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

app.get("/api/health", (request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/rooms", async (request, response) => {
  const { videoUrl } = request.body || {};
  const parsed = parseVideoUrl(videoUrl);

  if (parsed.error) {
    response.status(400).json({ message: parsed.error });
    return;
  }

  if (parsed.videoType === "mp4" && MP4_PROBE_ENABLED) {
    const probe = await validateMp4Url(parsed.normalizedUrl);

    if (!probe.ok) {
      response.status(400).json({
        message: probe.message,
        details: probe.details,
      });
      return;
    }
  }

  const room = createRoom({
    videoUrl: parsed.normalizedUrl,
    videoType: parsed.videoType,
    videoId: parsed.videoId,
  });

  response.status(201).json({
    roomId: room.roomId,
    url: `/room/${room.roomId}`,
  });
});

app.get("/api/rooms/:roomId", (request, response) => {
  const room = getRoom(request.params.roomId);

  if (!room) {
    response.status(404).json({ message: "Кімнату не знайдено." });
    return;
  }

  response.json(getRoomState(room));
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  },
});

io.on("connection", (socket) => {
  function leaveCurrentRoom() {
    const currentRoomId = socket.data.roomId;

    if (!currentRoomId) {
      return;
    }

    socket.leave(currentRoomId);
    const room = decrementUsers(currentRoomId);
    socket.data.roomId = null;

    if (room) {
      io.to(currentRoomId).emit("userLeft", { usersCount: room.usersCount });
    }
  }

  socket.on("joinRoom", ({ roomId } = {}) => {
    if (!roomId) {
      socket.emit("roomError", { message: "Не передано roomId." });
      return;
    }

    const room = getRoom(roomId);

    if (!room) {
      socket.emit("roomError", { message: "Кімнату не знайдено." });
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== roomId) {
      leaveCurrentRoom();
    }

    if (socket.data.roomId === roomId) {
      socket.emit("roomState", getRoomState(room));
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    const updatedRoom = incrementUsers(roomId);

    if (!updatedRoom) {
      socket.emit("roomError", { message: "Не вдалося приєднатися до кімнати." });
      return;
    }

    const snapshot = getRoomState(updatedRoom);
    socket.emit("roomState", snapshot);
    io.to(roomId).emit("userJoined", { usersCount: snapshot.usersCount });
  });

  socket.on("play", ({ roomId, currentTime } = {}) => {
    // Future extension point: check host permissions when controlMode !== "all".
    const room = setPlaybackState(roomId, { isPlaying: true, currentTime });

    if (!room) {
      return;
    }

    socket.to(roomId).emit("play", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  socket.on("pause", ({ roomId, currentTime } = {}) => {
    // Future extension point: check host permissions when controlMode !== "all".
    const room = setPlaybackState(roomId, { isPlaying: false, currentTime });

    if (!room) {
      return;
    }

    socket.to(roomId).emit("pause", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
    });
  });

  socket.on("seek", ({ roomId, currentTime } = {}) => {
    // Future extension point: check host permissions when controlMode !== "all".
    const room = setSeekState(roomId, currentTime);

    if (!room) {
      return;
    }

    socket.to(roomId).emit("seek", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
      isPlaying: room.isPlaying,
    });
  });

  socket.on("syncRequest", ({ roomId } = {}) => {
    const targetRoomId = roomId || socket.data.roomId;

    if (!targetRoomId) {
      return;
    }

    const room = getRoom(targetRoomId);

    if (!room) {
      socket.emit("roomError", { message: "Кімнату не знайдено." });
      return;
    }

    socket.emit("syncResponse", getRoomState(room));
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom();
  });
});

setInterval(() => {
  clearIdleRooms(ROOM_TTL_MINUTES * 60 * 1000);
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Watch Party backend listening on port ${PORT}`);
});
