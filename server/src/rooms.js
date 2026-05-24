const { randomUUID } = require("node:crypto");
const { createClient } = require("redis");

const ROOM_ID_LENGTH = 6;
const ROOM_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_NICKNAME_LENGTH = 24;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "watchparty";
const ROOM_TTL_MINUTES = Number(process.env.ROOM_TTL_MINUTES || 30);
const CONTROL_MODES = new Set(["all", "host"]);
const ROOM_TTL_SECONDS =
  ROOM_TTL_MINUTES > 0 ? Math.max(60, Math.floor(ROOM_TTL_MINUTES * 60)) : 0;
const ROOMS_INDEX_KEY = `${REDIS_KEY_PREFIX}:rooms:index`;

let redisClient;
let redisConnected = false;

function getRoomMetaKey(roomId) {
  return `${REDIS_KEY_PREFIX}:room:${roomId}:meta`;
}

function getRoomParticipantsKey(roomId) {
  return `${REDIS_KEY_PREFIX}:room:${roomId}:participants`;
}

function generateRoomId() {
  let roomId = "";

  for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_ID_CHARS.length);
    roomId += ROOM_ID_CHARS[randomIndex];
  }

  return roomId;
}

function normalizeTime(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function sanitizeNickname(value) {
  const trimmed = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.slice(0, MAX_NICKNAME_LENGTH);
}

function normalizeVideoType(videoType, videoUrl) {
  if (videoType === "mp4") {
    return "mp4";
  }

  if (typeof videoUrl === "string" && videoUrl.toLowerCase().endsWith(".mp4")) {
    return "mp4";
  }

  return "youtube";
}

function normalizeControlMode(controlMode) {
  const safeMode = String(controlMode || "")
    .trim()
    .toLowerCase();

  if (!CONTROL_MODES.has(safeMode)) {
    return "all";
  }

  return safeMode;
}

function normalizeSocketId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeClientId(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 128);
}

function resolveHostSocketId(participants, preferredHostSocketId) {
  const safePreferredHostSocketId = normalizeSocketId(preferredHostSocketId);

  if (
    safePreferredHostSocketId &&
    Array.isArray(participants) &&
    participants.some((participant) => participant.socketId === safePreferredHostSocketId)
  ) {
    return safePreferredHostSocketId;
  }

  if (!Array.isArray(participants) || participants.length === 0) {
    return null;
  }

  return normalizeSocketId(participants[0]?.socketId);
}

function createGuestNickname(socketId) {
  const suffix = String(socketId || "")
    .slice(-4)
    .toUpperCase();
  return `Гість-${suffix || "USER"}`;
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function hashString(value) {
  const input = String(value || "");
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function normalizePlaylistItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") {
    return null;
  }

  const videoUrl = String(rawItem.videoUrl || "").trim();

  if (!videoUrl) {
    return null;
  }

  return {
    itemId: String(rawItem.itemId || randomUUID()),
    videoUrl,
    videoType: normalizeVideoType(rawItem.videoType, videoUrl),
    videoId: rawItem.videoId ? String(rawItem.videoId) : null,
    addedAt: Number(rawItem.addedAt) || Date.now(),
    addedBy: sanitizeNickname(rawItem.addedBy) || null,
  };
}

function createPlaylistItem({ videoUrl, videoType, videoId, addedBy }) {
  return {
    itemId: randomUUID(),
    videoUrl,
    videoType: normalizeVideoType(videoType, videoUrl),
    videoId: videoId || null,
    addedAt: Date.now(),
    addedBy: sanitizeNickname(addedBy) || null,
  };
}

function createLegacyPlaylistItem({ videoUrl, videoType, videoId }, addedAt) {
  const deterministicId = `legacy-${hashString(`${videoType}:${videoId || videoUrl}`)}`;

  return {
    itemId: deterministicId,
    videoUrl,
    videoType: normalizeVideoType(videoType, videoUrl),
    videoId: videoId || null,
    addedAt: Number(addedAt) || Date.now(),
    addedBy: null,
  };
}

function normalizePlaylist(playlist, fallbackVideo, fallbackAddedAt) {
  const normalized = [];

  if (Array.isArray(playlist)) {
    for (const rawItem of playlist) {
      const item = normalizePlaylistItem(rawItem);

      if (item) {
        normalized.push(item);
      }
    }
  }

  if (normalized.length === 0 && fallbackVideo?.videoUrl) {
    normalized.push(
      createLegacyPlaylistItem(
        {
          videoUrl: fallbackVideo.videoUrl,
          videoType: fallbackVideo.videoType,
          videoId: fallbackVideo.videoId || null,
        },
        fallbackAddedAt
      )
    );
  }

  return normalized;
}

function normalizeCurrentIndex(value, playlistLength) {
  if (playlistLength <= 0) {
    return 0;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return 0;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed >= playlistLength) {
    return playlistLength - 1;
  }

  return parsed;
}

function normalizeRoomMeta(room) {
  if (!room || typeof room !== "object") {
    return null;
  }

  const roomId = String(room.roomId || "").trim();

  if (!roomId) {
    return null;
  }

  const updatedAt = Number(room.updatedAt) || Date.now();
  const createdAt = Number(room.createdAt) || updatedAt;
  const normalizedPlaylist = normalizePlaylist(
    room.playlist,
    {
      videoUrl: room.videoUrl,
      videoType: room.videoType,
      videoId: room.videoId || null,
    },
    updatedAt
  );
  const currentIndex = normalizeCurrentIndex(room.currentIndex, normalizedPlaylist.length);
  const currentItem = normalizedPlaylist[currentIndex] || null;

  return {
    roomId,
    createdAt,
    videoUrl: currentItem?.videoUrl || "",
    videoType: currentItem?.videoType || "youtube",
    videoId: currentItem?.videoId || null,
    playlist: normalizedPlaylist,
    currentIndex,
    controlMode: normalizeControlMode(room.controlMode),
    hostSocketId: normalizeSocketId(room.hostSocketId),
    isPlaying: Boolean(room.isPlaying),
    currentTime: normalizeTime(room.currentTime),
    updatedAt,
    emptySince: Number.isFinite(Number(room.emptySince)) ? Number(room.emptySince) : null,
  };
}

function serializeRoomMeta(room) {
  const normalized = normalizeRoomMeta(room);

  if (!normalized) {
    return null;
  }

  return JSON.stringify(normalized);
}

function parseParticipantsHash(hash) {
  const participants = [];

  for (const value of Object.values(hash || {})) {
    const participant = safeParseJson(value);

    if (!participant || !participant.socketId) {
      continue;
    }

    participants.push({
      socketId: String(participant.socketId),
      nickname: sanitizeNickname(participant.nickname) || createGuestNickname(participant.socketId),
      clientId: normalizeClientId(participant.clientId),
      joinedAt: Number(participant.joinedAt) || Date.now(),
    });
  }

  participants.sort((left, right) => left.joinedAt - right.joinedAt);
  return participants;
}

function getCurrentItem(room) {
  if (!room || !Array.isArray(room.playlist) || room.playlist.length === 0) {
    return null;
  }

  const safeIndex = normalizeCurrentIndex(room.currentIndex, room.playlist.length);
  return room.playlist[safeIndex] || null;
}

function applyCurrentItemToRoom(room) {
  const currentItem = getCurrentItem(room);

  if (!currentItem) {
    room.videoUrl = "";
    room.videoType = "youtube";
    room.videoId = null;
    room.currentIndex = 0;
    room.isPlaying = false;
    room.currentTime = 0;
    return;
  }

  room.currentIndex = normalizeCurrentIndex(room.currentIndex, room.playlist.length);
  room.videoUrl = currentItem.videoUrl;
  room.videoType = currentItem.videoType;
  room.videoId = currentItem.videoId;
}

async function ensureRedisConnection() {
  if (redisConnected && redisClient?.isReady) {
    return redisClient;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: (retries) => {
          if (retries >= 10) {
            return new Error("Redis reconnect limit reached.");
          }

          return Math.min(150 + retries * 100, 1000);
        },
      },
    });

    redisClient.on("error", (error) => {
      console.error("Redis error:", error.message);
    });
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  redisConnected = true;
  return redisClient;
}

async function expireRoomKeys(roomId) {
  if (ROOM_TTL_SECONDS <= 0) {
    return;
  }

  const client = await ensureRedisConnection();
  await client
    .multi()
    .expire(getRoomMetaKey(roomId), ROOM_TTL_SECONDS)
    .expire(getRoomParticipantsKey(roomId), ROOM_TTL_SECONDS)
    .exec();
}

async function deleteRoom(roomId) {
  const client = await ensureRedisConnection();
  await client
    .multi()
    .del(getRoomMetaKey(roomId))
    .del(getRoomParticipantsKey(roomId))
    .sRem(ROOMS_INDEX_KEY, roomId)
    .exec();
}

async function saveRoomMeta(room) {
  applyCurrentItemToRoom(room);
  const serialized = serializeRoomMeta(room);

  if (!serialized) {
    return null;
  }

  const client = await ensureRedisConnection();

  if (ROOM_TTL_SECONDS > 0) {
    await client.set(getRoomMetaKey(room.roomId), serialized, { EX: ROOM_TTL_SECONDS });
  } else {
    await client.set(getRoomMetaKey(room.roomId), serialized);
  }

  await client.sAdd(ROOMS_INDEX_KEY, room.roomId);

  if (ROOM_TTL_SECONDS > 0) {
    await client.expire(getRoomParticipantsKey(room.roomId), ROOM_TTL_SECONDS);
  }

  return normalizeRoomMeta(room);
}

async function buildRoomWithParticipants(roomId, { touchTtl = false } = {}) {
  const client = await ensureRedisConnection();
  const roomMetaRaw = await client.get(getRoomMetaKey(roomId));

  if (!roomMetaRaw) {
    await client.sRem(ROOMS_INDEX_KEY, roomId);
    return null;
  }

  const roomMeta = normalizeRoomMeta(safeParseJson(roomMetaRaw));

  if (!roomMeta) {
    await deleteRoom(roomId);
    return null;
  }

  const participantsHash = await client.hGetAll(getRoomParticipantsKey(roomId));
  const participants = parseParticipantsHash(participantsHash);
  const hostSocketId = resolveHostSocketId(participants, roomMeta.hostSocketId);

  if (touchTtl && ROOM_TTL_SECONDS > 0) {
    await expireRoomKeys(roomId);
  }

  return {
    ...roomMeta,
    hostSocketId,
    participants,
  };
}

function getRoomState(room) {
  const serverNowMs = Date.now();
  const currentItem = getCurrentItem(room);
  const participants = Array.isArray(room.participants) ? room.participants : [];
  const hostSocketId = resolveHostSocketId(participants, room.hostSocketId);
  const hostParticipant = hostSocketId
    ? participants.find((participant) => participant.socketId === hostSocketId) || null
    : null;
  const stateCurrentTime = normalizeTime(room.currentTime);
  const currentTime =
    room.isPlaying && currentItem
      ? normalizeTime(stateCurrentTime + (serverNowMs - room.updatedAt) / 1000)
      : stateCurrentTime;

  return {
    roomId: room.roomId,
    createdAt: Number(room.createdAt) || room.updatedAt,
    videoUrl: currentItem?.videoUrl || "",
    videoType: currentItem?.videoType || "youtube",
    videoId: currentItem?.videoId || null,
    playlist: room.playlist || [],
    currentIndex: normalizeCurrentIndex(room.currentIndex, room.playlist?.length || 0),
    currentItem,
    controlMode: normalizeControlMode(room.controlMode),
    hostSocketId,
    hostNickname: hostParticipant?.nickname || null,
    isPlaying: room.isPlaying,
    currentTime,
    stateCurrentTime,
    updatedAt: room.updatedAt,
    stateUpdatedAt: room.updatedAt,
    serverNowMs,
    usersCount: participants.length,
    participants,
  };
}

async function connectRoomsStore() {
  await ensureRedisConnection();
}

async function disconnectRoomsStore() {
  if (!redisClient || !redisClient.isOpen) {
    return;
  }

  await redisClient.quit();
  redisConnected = false;
}

async function createRoom({ videoUrl, videoType, videoId }) {
  const client = await ensureRedisConnection();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const roomId = generateRoomId();
    const playlistItem = createPlaylistItem({
      videoUrl,
      videoType,
      videoId,
      addedBy: null,
    });
    const createdAt = Date.now();
    const room = {
      roomId,
      playlist: [playlistItem],
      currentIndex: 0,
      controlMode: "all",
      hostSocketId: null,
      isPlaying: false,
      currentTime: 0,
      createdAt,
      updatedAt: createdAt,
      emptySince: null,
    };
    applyCurrentItemToRoom(room);

    const serialized = serializeRoomMeta(room);
    const setOptions = ROOM_TTL_SECONDS > 0 ? { NX: true, EX: ROOM_TTL_SECONDS } : { NX: true };
    const result = await client.set(getRoomMetaKey(roomId), serialized, setOptions);

    if (result === "OK") {
      await client.sAdd(ROOMS_INDEX_KEY, roomId);
      return {
        ...room,
        participants: [],
      };
    }
  }

  throw new Error("Не вдалося згенерувати унікальний roomId.");
}

async function getRoom(roomId, options = {}) {
  if (!roomId) {
    return null;
  }

  return buildRoomWithParticipants(roomId, options);
}

async function setPlaybackState(roomId, { isPlaying, currentTime }) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room) {
    return null;
  }

  room.isPlaying = isPlaying;
  room.currentTime = normalizeTime(currentTime);
  room.updatedAt = Date.now();
  room.emptySince = room.participants.length === 0 ? room.emptySince || Date.now() : null;

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return null;
  }

  return {
    ...savedRoom,
    participants: room.participants,
  };
}

async function setSeekState(roomId, currentTime) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room) {
    return null;
  }

  room.currentTime = normalizeTime(currentTime);
  room.updatedAt = Date.now();
  room.emptySince = room.participants.length === 0 ? room.emptySince || Date.now() : null;

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return null;
  }

  return {
    ...savedRoom,
    participants: room.participants,
  };
}

async function addPlaylistItem(roomId, { videoUrl, videoType, videoId, addedBy }) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room) {
    return {
      room: null,
      item: null,
    };
  }

  const item = createPlaylistItem({
    videoUrl,
    videoType,
    videoId,
    addedBy,
  });

  room.playlist = room.playlist.concat(item);
  room.emptySince = room.participants.length === 0 ? room.emptySince || Date.now() : null;

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return {
      room: null,
      item: null,
    };
  }

  return {
    room: {
      ...savedRoom,
      participants: room.participants,
    },
    item,
  };
}

async function removePlaylistItem(roomId, itemId) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room || !itemId) {
    return {
      room: null,
      removedItem: null,
      blocked: false,
    };
  }

  const targetIndex = room.playlist.findIndex((item) => item.itemId === itemId);

  if (targetIndex < 0) {
    return {
      room,
      removedItem: null,
      blocked: false,
    };
  }

  if (room.playlist.length <= 1) {
    return {
      room,
      removedItem: null,
      blocked: true,
    };
  }

  const removedItem = room.playlist[targetIndex];
  room.playlist.splice(targetIndex, 1);

  if (targetIndex < room.currentIndex) {
    room.currentIndex -= 1;
  } else if (targetIndex === room.currentIndex) {
    const nextIndex = Math.min(room.currentIndex, room.playlist.length - 1);
    room.currentIndex = nextIndex;
    room.currentTime = 0;
    room.updatedAt = Date.now();
    room.isPlaying = true;
  }

  room.currentIndex = normalizeCurrentIndex(room.currentIndex, room.playlist.length);

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return {
      room: null,
      removedItem: null,
      blocked: false,
    };
  }

  return {
    room: {
      ...savedRoom,
      participants: room.participants,
    },
    removedItem,
    blocked: false,
  };
}

async function setCurrentPlaylistItem(roomId, itemId, { autoplay = true } = {}) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room || !itemId) {
    return {
      room: null,
      changed: false,
    };
  }

  const targetIndex = room.playlist.findIndex((item) => item.itemId === itemId);

  if (targetIndex < 0) {
    return {
      room,
      changed: false,
    };
  }

  room.currentIndex = targetIndex;
  room.currentTime = 0;
  room.updatedAt = Date.now();
  room.isPlaying = Boolean(autoplay);

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return {
      room: null,
      changed: false,
    };
  }

  return {
    room: {
      ...savedRoom,
      participants: room.participants,
    },
    changed: true,
  };
}

async function advancePlaylist(roomId, { expectedItemId } = {}) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room) {
    return {
      room: null,
      changed: false,
      reason: "missing",
    };
  }

  const currentItem = getCurrentItem(room);

  if (!currentItem) {
    return {
      room,
      changed: false,
      reason: "empty",
    };
  }

  if (expectedItemId && expectedItemId !== currentItem.itemId) {
    return {
      room,
      changed: false,
      reason: "stale",
    };
  }

  if (room.currentIndex >= room.playlist.length - 1) {
    room.isPlaying = false;
    room.currentTime = 0;
    room.updatedAt = Date.now();
    const savedRoom = await saveRoomMeta(room);

    if (!savedRoom) {
      return {
        room: null,
        changed: false,
        reason: "save_failed",
      };
    }

    return {
      room: {
        ...savedRoom,
        participants: room.participants,
      },
      changed: false,
      reason: "last_item",
    };
  }

  room.currentIndex += 1;
  room.currentTime = 0;
  room.updatedAt = Date.now();
  room.isPlaying = true;

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return {
      room: null,
      changed: false,
      reason: "save_failed",
    };
  }

  return {
    room: {
      ...savedRoom,
      participants: room.participants,
    },
    changed: true,
    reason: "advanced",
  };
}

async function upsertParticipant(roomId, { socketId, nickname, clientId }) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room || !socketId) {
    return null;
  }

  const client = await ensureRedisConnection();
  const participantsKey = getRoomParticipantsKey(roomId);
  const safeNickname = sanitizeNickname(nickname) || createGuestNickname(socketId);
  const safeClientId = normalizeClientId(clientId);
  const existingBySocket = room.participants.find((participant) => participant.socketId === socketId);
  const existingByClientId = safeClientId
    ? room.participants.find((participant) => participant.clientId === safeClientId)
    : null;
  const previousParticipant = existingBySocket || existingByClientId || null;
  const previousHostSocketId = room.hostSocketId;
  const previousSocketIdForSameClient =
    existingByClientId && existingByClientId.socketId !== socketId
      ? existingByClientId.socketId
      : null;

  if (previousSocketIdForSameClient) {
    await client.hDel(participantsKey, previousSocketIdForSameClient);
  }

  const participant = previousParticipant
    ? {
        ...previousParticipant,
        socketId,
        nickname: safeNickname,
        clientId: safeClientId,
      }
    : {
        socketId,
        nickname: safeNickname,
        clientId: safeClientId,
        joinedAt: Date.now(),
      };

  await client.hSet(participantsKey, socketId, JSON.stringify(participant));

  if (ROOM_TTL_SECONDS > 0) {
    await expireRoomKeys(roomId);
  }

  room.participants = room.participants
    .filter((item) => {
      if (item.socketId === socketId) {
        return false;
      }

      if (previousSocketIdForSameClient && item.socketId === previousSocketIdForSameClient) {
        return false;
      }

      if (safeClientId && item.clientId === safeClientId) {
        return false;
      }

      return true;
    })
    .concat(participant)
    .sort((left, right) => left.joinedAt - right.joinedAt);

  if (previousSocketIdForSameClient && previousHostSocketId === previousSocketIdForSameClient) {
    room.hostSocketId = socketId;
  }

  room.hostSocketId = resolveHostSocketId(room.participants, room.hostSocketId);
  room.emptySince = null;

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return null;
  }

  return {
    ...savedRoom,
    participants: room.participants,
  };
}

async function removeParticipant(roomId, socketId) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room || !socketId) {
    return {
      room: null,
      removedParticipant: null,
    };
  }

  const removedParticipant = room.participants.find((participant) => participant.socketId === socketId) || null;
  const client = await ensureRedisConnection();
  await client.hDel(getRoomParticipantsKey(roomId), socketId);

  room.participants = room.participants.filter((participant) => participant.socketId !== socketId);
  room.hostSocketId = resolveHostSocketId(room.participants, room.hostSocketId);
  room.emptySince = room.participants.length === 0 ? Date.now() : null;

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return {
      room: null,
      removedParticipant,
    };
  }

  if (ROOM_TTL_SECONDS > 0) {
    await expireRoomKeys(roomId);
  }

  return {
    room: {
      ...savedRoom,
      participants: room.participants,
    },
    removedParticipant,
  };
}

async function clearIdleRooms(maxIdleMs) {
  const removedRooms = [];

  if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) {
    return {
      removedRooms,
    };
  }

  const client = await ensureRedisConnection();
  const roomIds = await client.sMembers(ROOMS_INDEX_KEY);
  const now = Date.now();

  for (const roomId of roomIds) {
    const room = await getRoom(roomId, { touchTtl: false });

    if (!room) {
      continue;
    }

    if (room.participants.length > 0 || !room.emptySince) {
      continue;
    }

    if (now - room.emptySince > maxIdleMs) {
      await deleteRoom(roomId);
      removedRooms.push({
        roomId,
        createdAt: Number(room.createdAt) || Number(room.updatedAt) || now,
        removedAt: Date.now(),
        reason: "idle_ttl",
      });
    }
  }

  return {
    removedRooms,
  };
}

async function setRoomControlMode(roomId, controlMode) {
  const room = await getRoom(roomId, { touchTtl: false });

  if (!room) {
    return null;
  }

  room.controlMode = normalizeControlMode(controlMode);
  room.hostSocketId = resolveHostSocketId(room.participants, room.hostSocketId);

  const savedRoom = await saveRoomMeta(room);

  if (!savedRoom) {
    return null;
  }

  return {
    ...savedRoom,
    participants: room.participants,
  };
}

module.exports = {
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
};
