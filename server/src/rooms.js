const rooms = new Map();
const ROOM_ID_LENGTH = 6;
const ROOM_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

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

function resolveCurrentTime(room) {
  if (!room.isPlaying) {
    return normalizeTime(room.currentTime);
  }

  const elapsedSeconds = (Date.now() - room.updatedAt) / 1000;
  return normalizeTime(room.currentTime + elapsedSeconds);
}

function getRoomState(room) {
  return {
    roomId: room.roomId,
    videoUrl: room.videoUrl,
    videoType: room.videoType,
    videoId: room.videoId,
    controlMode: room.controlMode,
    isPlaying: room.isPlaying,
    currentTime: resolveCurrentTime(room),
    updatedAt: Date.now(),
    usersCount: room.usersCount,
  };
}

function createRoom({ videoUrl, videoType, videoId }) {
  let roomId = generateRoomId();

  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  const room = {
    roomId,
    videoUrl,
    videoType,
    videoId: videoId || null,
    controlMode: "all",
    isPlaying: false,
    currentTime: 0,
    updatedAt: Date.now(),
    usersCount: 0,
    emptySince: null,
  };

  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function setPlaybackState(roomId, { isPlaying, currentTime }) {
  const room = getRoom(roomId);

  if (!room) {
    return null;
  }

  room.isPlaying = isPlaying;
  room.currentTime = normalizeTime(currentTime);
  room.updatedAt = Date.now();

  return room;
}

function setSeekState(roomId, currentTime) {
  const room = getRoom(roomId);

  if (!room) {
    return null;
  }

  room.currentTime = normalizeTime(currentTime);
  room.updatedAt = Date.now();

  return room;
}

function incrementUsers(roomId) {
  const room = getRoom(roomId);

  if (!room) {
    return null;
  }

  room.usersCount += 1;
  room.emptySince = null;
  return room;
}

function decrementUsers(roomId) {
  const room = getRoom(roomId);

  if (!room) {
    return null;
  }

  room.usersCount = Math.max(0, room.usersCount - 1);

  if (room.usersCount === 0) {
    room.emptySince = Date.now();
  }

  return room;
}

function clearIdleRooms(maxIdleMs) {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    if (room.usersCount > 0 || !room.emptySince) {
      continue;
    }

    if (now - room.emptySince > maxIdleMs) {
      rooms.delete(roomId);
    }
  }
}

module.exports = {
  createRoom,
  getRoom,
  getRoomState,
  setPlaybackState,
  setSeekState,
  incrementUsers,
  decrementUsers,
  clearIdleRooms,
};
