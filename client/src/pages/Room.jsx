import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import VideoPlayer from "../components/VideoPlayer";
import { getSocket } from "../socket";
import { parseVideoUrl } from "../utils/videoParser";

const REMOTE_ACTION_LOCK_MS = 1000;
const AUTO_SYNC_INTERVAL_MS = 7000;
const CLOCK_SYNC_INTERVAL_MS = 25000;
const CLOCK_SYNC_TIMEOUT_MS = 2500;
const CLOCK_SYNC_ATTEMPTS = 4;
const MAX_ACCEPTABLE_RTT_MS = 2200;
const MAX_CLOCK_SAMPLES = 12;
const BEST_CLOCK_SAMPLES = 4;
const HARD_DRIFT_THRESHOLD_SEC = 1.35;
const SOFT_DRIFT_THRESHOLD_SEC = 0.55;
const DRIFT_CORRECTION_COOLDOWN_MS = 4000;
const RECONNECT_RESYNC_DELAY_MS = 500;
const RECONNECT_RETRY_PULSE_MS = 5000;
const NICKNAME_STORAGE_KEY = "watchparty:nickname";
const MAX_NICKNAME_LENGTH = 24;
const PLAYLIST_MAX_ITEMS = 50;

function sanitizeNickname(value) {
  const trimmed = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.slice(0, MAX_NICKNAME_LENGTH);
}

function getStoredNickname() {
  if (typeof window === "undefined") {
    return "";
  }

  return sanitizeNickname(window.localStorage.getItem(NICKNAME_STORAGE_KEY) || "");
}

function formatDisconnectReason(reason) {
  if (reason === "ping timeout") {
    return "Таймаут ping/pong";
  }

  if (reason === "transport close") {
    return "Мережа тимчасово недоступна";
  }

  if (reason === "transport error") {
    return "Помилка транспортного каналу";
  }

  if (reason === "io server disconnect") {
    return "Сервер закрив сесію";
  }

  if (reason === "io client disconnect") {
    return "Зʼєднання закрито локально";
  }

  return "Невідома причина";
}

function Room() {
  const { roomId } = useParams();
  const [loading, setLoading] = useState(true);
  const [roomState, setRoomState] = useState(null);
  const [usersCount, setUsersCount] = useState(0);
  const [participants, setParticipants] = useState([]);
  const [nickname, setNickname] = useState(() => getStoredNickname());
  const [nicknameDraft, setNicknameDraft] = useState(() => getStoredNickname());
  const [playlistUrlDraft, setPlaylistUrlDraft] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");

  const playerRef = useRef(null);
  const socketRef = useRef(null);
  const roomStateRef = useRef(null);
  const nicknameRef = useRef(nickname);
  const ignoreNextEventRef = useRef(false);
  const infoTimeoutRef = useRef(null);
  const reconnectResyncTimeoutRef = useRef(null);
  const hasConnectedOnceRef = useRef(false);
  const lastDisconnectReasonRef = useRef(null);
  const previousControlModeRef = useRef(null);
  const driftCorrectionAtRef = useRef(0);
  const serverClockRef = useRef({
    offsetMs: 0,
    lastRttMs: null,
    syncedAt: 0,
    samples: [],
  });

  const roomUrl = useMemo(
    () => `${window.location.origin}/room/${roomId}`,
    [roomId]
  );
  const sortedParticipants = useMemo(() => {
    return [...participants].sort((left, right) => {
      const leftJoined = Number(left?.joinedAt || 0);
      const rightJoined = Number(right?.joinedAt || 0);
      return leftJoined - rightJoined;
    });
  }, [participants]);
  const playlist = useMemo(() => {
    return Array.isArray(roomState?.playlist) ? roomState.playlist : [];
  }, [roomState?.playlist]);
  const currentPlaylistIndex = useMemo(() => {
    const parsed = Number(roomState?.currentIndex);

    if (!Number.isInteger(parsed)) {
      return 0;
    }

    if (playlist.length === 0) {
      return 0;
    }

    if (parsed < 0) {
      return 0;
    }

    if (parsed >= playlist.length) {
      return playlist.length - 1;
    }

    return parsed;
  }, [roomState?.currentIndex, playlist]);
  const currentPlaylistItem = useMemo(() => {
    if (!playlist.length) {
      return null;
    }

    return playlist[currentPlaylistIndex] || playlist[0];
  }, [currentPlaylistIndex, playlist]);
  const ownSocketId = socketRef.current?.id || null;
  const hostSocketId = roomState?.hostSocketId || null;
  const hostNickname = useMemo(() => {
    if (!hostSocketId) {
      return roomState?.hostNickname || null;
    }

    const participant = sortedParticipants.find((entry) => entry.socketId === hostSocketId);
    return participant?.nickname || roomState?.hostNickname || null;
  }, [hostSocketId, roomState?.hostNickname, sortedParticipants]);
  const isHostOnlyMode = roomState?.controlMode === "host";
  const isHost = Boolean(ownSocketId && hostSocketId && ownSocketId === hostSocketId);
  const canControlRoom = !isHostOnlyMode || isHost;

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  useEffect(() => {
    nicknameRef.current = nickname;
  }, [nickname]);

  const normalizeTime = useCallback((value) => {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }

    return parsed;
  }, []);

  const estimateServerNowMs = useCallback(
    () => Date.now() + serverClockRef.current.offsetMs,
    []
  );

  const showInfo = useCallback((message) => {
    setInfoMessage(message);
    window.clearTimeout(infoTimeoutRef.current);
    infoTimeoutRef.current = window.setTimeout(() => setInfoMessage(""), 2500);
  }, []);

  useEffect(() => {
    const currentMode = roomState?.controlMode || null;
    const previousMode = previousControlModeRef.current;

    if (previousMode && currentMode && previousMode !== currentMode) {
      showInfo(
        currentMode === "host"
          ? "Увімкнено режим: керує тільки хост"
          : "Увімкнено режим: керувати можуть усі"
      );
    }

    previousControlModeRef.current = currentMode;
  }, [roomState?.controlMode, showInfo]);

  const withRemoteLock = useCallback((action) => {
    ignoreNextEventRef.current = true;
    action();
    window.setTimeout(() => {
      ignoreNextEventRef.current = false;
    }, REMOTE_ACTION_LOCK_MS);
  }, []);

  const updateClockEstimate = useCallback((offsetMs, rttMs) => {
    if (!Number.isFinite(offsetMs) || !Number.isFinite(rttMs)) {
      return;
    }

    if (rttMs > MAX_ACCEPTABLE_RTT_MS) {
      return;
    }

    const state = serverClockRef.current;
    state.samples.push({ offsetMs, rttMs });

    if (state.samples.length > MAX_CLOCK_SAMPLES) {
      state.samples.shift();
    }

    const bestSamples = [...state.samples]
      .sort((left, right) => left.rttMs - right.rttMs)
      .slice(0, BEST_CLOCK_SAMPLES);

    let weightedOffsetSum = 0;
    let weightSum = 0;

    for (const sample of bestSamples) {
      const weight = 1 / Math.max(sample.rttMs, 1);
      weightedOffsetSum += sample.offsetMs * weight;
      weightSum += weight;
    }

    if (weightSum > 0) {
      state.offsetMs = weightedOffsetSum / weightSum;
      state.lastRttMs = rttMs;
      state.syncedAt = Date.now();
    }
  }, []);

  const requestClockSample = useCallback((socket) => {
    return new Promise((resolve) => {
      const clientSentAt = Date.now();
      let finished = false;

      const timeout = window.setTimeout(() => {
        if (finished) {
          return;
        }

        finished = true;
        resolve(null);
      }, CLOCK_SYNC_TIMEOUT_MS);

      socket.emit("timeSync", { clientSentAt }, (payload) => {
        if (finished) {
          return;
        }

        finished = true;
        window.clearTimeout(timeout);

        const serverNowMs = Number(payload?.serverNowMs);
        if (!Number.isFinite(serverNowMs)) {
          resolve(null);
          return;
        }

        const clientReceivedAt = Date.now();
        const rttMs = clientReceivedAt - clientSentAt;
        const midpointMs = clientSentAt + rttMs / 2;
        const offsetMs = serverNowMs - midpointMs;

        resolve({
          offsetMs,
          rttMs,
        });
      });
    });
  }, []);

  const syncServerClock = useCallback(
    async ({ attempts = CLOCK_SYNC_ATTEMPTS } = {}) => {
      const socket = socketRef.current;

      if (!socket || !socket.connected) {
        return;
      }

      for (let sampleIndex = 0; sampleIndex < attempts; sampleIndex += 1) {
        const sample = await requestClockSample(socket);

        if (sample) {
          updateClockEstimate(sample.offsetMs, sample.rttMs);
        }
      }
    },
    [requestClockSample, updateClockEstimate]
  );

  const consumeServerNowHint = useCallback((payload) => {
    const serverNowMs = Number(payload?.serverNowMs);

    if (!Number.isFinite(serverNowMs)) {
      return;
    }

    const coarseOffsetMs = serverNowMs - Date.now();
    updateClockEstimate(coarseOffsetMs, MAX_ACCEPTABLE_RTT_MS);
  }, [updateClockEstimate]);

  const resolveExpectedTime = useCallback(
    (snapshot) => {
      if (!snapshot) {
        return 0;
      }

      const stateCurrentTime = Number(snapshot.stateCurrentTime);
      const stateUpdatedAt = Number(snapshot.stateUpdatedAt);
      const hasPreciseState =
        Number.isFinite(stateCurrentTime) && Number.isFinite(stateUpdatedAt);

      if (hasPreciseState) {
        const baseTime = normalizeTime(stateCurrentTime);

        if (!snapshot.isPlaying) {
          return baseTime;
        }

        const elapsedSec = Math.max(0, (estimateServerNowMs() - stateUpdatedAt) / 1000);
        return normalizeTime(baseTime + elapsedSec);
      }

      return normalizeTime(snapshot.currentTime);
    },
    [estimateServerNowMs, normalizeTime]
  );

  const updateRoomStateFromSnapshot = useCallback(
    (snapshot, fallbackIsPlaying) => {
      const isPlaying =
        typeof snapshot.isPlaying === "boolean" ? snapshot.isPlaying : fallbackIsPlaying;
      const expectedTime = resolveExpectedTime({
        ...snapshot,
        isPlaying,
      });

      setRoomState((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          isPlaying,
          currentTime: expectedTime,
          stateCurrentTime: Number.isFinite(Number(snapshot.stateCurrentTime))
            ? Number(snapshot.stateCurrentTime)
            : expectedTime,
          updatedAt: Number.isFinite(Number(snapshot.updatedAt))
            ? Number(snapshot.updatedAt)
            : prev.updatedAt,
          stateUpdatedAt: Number.isFinite(Number(snapshot.stateUpdatedAt))
            ? Number(snapshot.stateUpdatedAt)
            : Number.isFinite(Number(snapshot.updatedAt))
              ? Number(snapshot.updatedAt)
              : prev.stateUpdatedAt,
          serverNowMs: Number.isFinite(Number(snapshot.serverNowMs))
            ? Number(snapshot.serverNowMs)
            : prev.serverNowMs,
        };
      });
    },
    [resolveExpectedTime]
  );

  const applySnapshotToPlayer = useCallback(
    (snapshot, { forceSeek = false, allowSoftCorrection = false } = {}) => {
      if (!snapshot || !playerRef.current) {
        return;
      }

      const targetTime = resolveExpectedTime(snapshot);

      withRemoteLock(() => {
        const player = playerRef.current;
        const localTime = Number(player.getCurrentTime?.() || 0);
        const driftSec = Math.abs(localTime - targetTime);
        const nowMs = Date.now();
        const correctionCooldownPassed =
          nowMs - driftCorrectionAtRef.current > DRIFT_CORRECTION_COOLDOWN_MS;
        const shouldHardSeek = forceSeek || driftSec >= HARD_DRIFT_THRESHOLD_SEC;
        const shouldSoftCorrect =
          allowSoftCorrection &&
          snapshot.isPlaying &&
          driftSec >= SOFT_DRIFT_THRESHOLD_SEC &&
          correctionCooldownPassed;

        if (shouldHardSeek || shouldSoftCorrect) {
          player.seekTo?.(targetTime);
          driftCorrectionAtRef.current = nowMs;
        }

        if (snapshot.isPlaying) {
          if (shouldHardSeek || shouldSoftCorrect) {
            player.play?.(targetTime);
          } else {
            player.play?.();
          }
          return;
        }

        if (shouldHardSeek || shouldSoftCorrect) {
          player.pause?.(targetTime);
        } else {
          player.pause?.();
        }
      });
    },
    [resolveExpectedTime, withRemoteLock]
  );

  const applyRoomMetaSnapshot = useCallback((snapshot) => {
    setRoomState(snapshot);
    setUsersCount(snapshot.usersCount || 0);
    setParticipants(Array.isArray(snapshot.participants) ? snapshot.participants : []);
  }, []);
  const applyPresenceSnapshot = useCallback((payload = {}) => {
    const list = Array.isArray(payload.participants) ? payload.participants : [];
    const countFromPayload = Number(payload.usersCount);

    setParticipants(list);
    setUsersCount(Number.isFinite(countFromPayload) ? countFromPayload : list.length);

    setRoomState((prev) => {
      if (!prev) {
        return prev;
      }

      return {
        ...prev,
        usersCount: Number.isFinite(countFromPayload) ? countFromPayload : list.length,
        participants: list,
        hostSocketId: payload.hostSocketId || prev.hostSocketId || null,
        hostNickname: payload.hostNickname || prev.hostNickname || null,
      };
    });
  }, []);

  const scheduleReconnectResync = useCallback(
    (socket) => {
      window.clearTimeout(reconnectResyncTimeoutRef.current);
      reconnectResyncTimeoutRef.current = window.setTimeout(() => {
        if (!socket.connected) {
          return;
        }

        socket.emit("syncRequest", { roomId, reason: "reconnect" });
      }, RECONNECT_RESYNC_DELAY_MS);
    },
    [roomId]
  );

  useEffect(() => {
    let canceled = false;

    async function fetchRoom() {
      try {
        setLoading(true);
        setError("");

        const response = await fetch(`/api/rooms/${roomId}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Не вдалося отримати стан кімнати.");
        }

        if (canceled) {
          return;
        }

        setRoomState(data);
        setUsersCount(data.usersCount || 0);
        setParticipants(Array.isArray(data.participants) ? data.participants : []);
      } catch (requestError) {
        if (!canceled) {
          setError(requestError.message || "Помилка завантаження кімнати.");
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }

    fetchRoom();

    return () => {
      canceled = true;
    };
  }, [roomId]);

  useEffect(() => {
    const socket = getSocket();
    const manager = socket.io;
    socketRef.current = socket;

    const handleConnect = () => {
      const isReconnect = hasConnectedOnceRef.current;
      const recovered = Boolean(socket.recovered);

      hasConnectedOnceRef.current = true;
      lastDisconnectReasonRef.current = null;
      setConnectionStatus("connected");
      setError("");
      socket.emit("joinRoom", {
        roomId,
        nickname: sanitizeNickname(nicknameRef.current),
      });

      void syncServerClock({
        attempts: isReconnect ? 2 : CLOCK_SYNC_ATTEMPTS,
      });

      if (isReconnect) {
        scheduleReconnectResync(socket);
        showInfo(
          recovered
            ? "Зʼєднання відновлено. Пропущені події підвантажено, виконуємо контрольну синхронізацію."
            : "Зʼєднання відновлено. Синхронізуємо актуальний стан кімнати."
        );
      }
    };

    const handleDisconnect = (reason) => {
      lastDisconnectReasonRef.current = reason || null;
      window.clearTimeout(reconnectResyncTimeoutRef.current);

      if (reason === "io client disconnect") {
        setConnectionStatus("disconnected");
        return;
      }

      if (socket.active) {
        setConnectionStatus("reconnecting");
        showInfo(`Зʼєднання втрачено: ${formatDisconnectReason(reason)}. Відновлюємо...`);
        return;
      }

      setConnectionStatus("disconnected");
      setError(
        `Втрачено зʼєднання (${formatDisconnectReason(
          reason
        )}). Перевірте мережу та натисніть "Синхронізуватися з хостом".`
      );
    };

    const handleRoomState = (snapshot) => {
      consumeServerNowHint(snapshot);
      applyRoomMetaSnapshot(snapshot);

      const ownParticipant = Array.isArray(snapshot.participants)
        ? snapshot.participants.find((participant) => participant.socketId === socket.id)
        : null;

      if (ownParticipant?.nickname) {
        setNickname(ownParticipant.nickname);
        setNicknameDraft(ownParticipant.nickname);
        window.localStorage.setItem(NICKNAME_STORAGE_KEY, ownParticipant.nickname);
      }

      applySnapshotToPlayer(snapshot, { forceSeek: true });
    };

    const handlePlay = (payload) => {
      consumeServerNowHint(payload);
      updateRoomStateFromSnapshot(payload, true);
      applySnapshotToPlayer(
        {
          ...payload,
          isPlaying: true,
        },
        { forceSeek: true }
      );
    };

    const handlePause = (payload) => {
      consumeServerNowHint(payload);
      updateRoomStateFromSnapshot(payload, false);
      applySnapshotToPlayer(
        {
          ...payload,
          isPlaying: false,
        },
        { forceSeek: true }
      );
    };

    const handleSeek = (payload) => {
      consumeServerNowHint(payload);

      const isPlaying =
        typeof payload.isPlaying === "boolean"
          ? payload.isPlaying
          : roomStateRef.current?.isPlaying || false;

      updateRoomStateFromSnapshot(payload, isPlaying);
      applySnapshotToPlayer(
        {
          ...payload,
          isPlaying,
        },
        { forceSeek: true }
      );
    };

    const handleSyncResponse = (snapshot) => {
      consumeServerNowHint(snapshot);

      const isManual = snapshot.reason === "manual";
      applyRoomMetaSnapshot(snapshot);
      applySnapshotToPlayer(snapshot, {
        forceSeek: isManual,
        allowSoftCorrection: !isManual,
      });

      if (isManual) {
        showInfo("Синхронізація виконана");
      }
    };

    const handlePlaylistUpdated = (snapshot) => {
      consumeServerNowHint(snapshot);
      const previousItemId = roomStateRef.current?.currentItem?.itemId || null;
      const nextItemId = snapshot?.currentItem?.itemId || null;
      const shouldReapplyToPlayer =
        previousItemId !== nextItemId || snapshot.action === "selected";

      applyRoomMetaSnapshot(snapshot);

      if (shouldReapplyToPlayer) {
        applySnapshotToPlayer(snapshot, { forceSeek: true });
      }

      if (snapshot.action === "added") {
        showInfo("Відео додано у плейлист");
      } else if (snapshot.action === "removed") {
        showInfo("Відео видалено з плейлиста");
      } else if (snapshot.action === "selected") {
        showInfo("Перемкнуто на інше відео");
      }
    };

    const handlePlaylistAdvanced = (snapshot) => {
      consumeServerNowHint(snapshot);
      applyRoomMetaSnapshot(snapshot);
      applySnapshotToPlayer(snapshot, { forceSeek: true });

      if (snapshot.reason === "auto_next") {
        showInfo("Автоперехід на наступне відео");
      } else if (snapshot.reason === "playlist_finished") {
        showInfo("Плейлист завершено");
      }
    };

    const handleUserJoined = (payload = {}) => {
      applyPresenceSnapshot(payload);

      if (payload.nickname) {
        showInfo(`${payload.nickname} приєднався до кімнати`);
      }
    };

    const handleUserLeft = (payload = {}) => {
      applyPresenceSnapshot(payload);

      if (payload.nickname) {
        showInfo(`${payload.nickname} вийшов з кімнати`);
      }
    };

    const handleRoomError = ({ message }) => {
      setError(message || "Помилка роботи з кімнатою.");
    };

    const handleConnectError = (connectionError) => {
      if (socket.active) {
        setConnectionStatus("reconnecting");
        return;
      }

      setConnectionStatus("disconnected");
      setError(connectionError.message || "Не вдалося підключитися до сервера.");
    };

    const handleReconnectAttempt = (attempt) => {
      setConnectionStatus("reconnecting");

      if (attempt === 1) {
        showInfo("Пробуємо відновити зʼєднання...");
      }
    };

    const handleReconnect = () => {
      setConnectionStatus("connected");
    };

    const handleReconnectError = () => {
      setConnectionStatus("reconnecting");
    };

    const handleReconnectFailed = () => {
      setConnectionStatus("disconnected");
      setError(
        "Автовідновлення зʼєднання не вдалося. Перевірте інтернет і натисніть \"Синхронізуватися з хостом\"."
      );
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("roomState", handleRoomState);
    socket.on("play", handlePlay);
    socket.on("pause", handlePause);
    socket.on("seek", handleSeek);
    socket.on("syncResponse", handleSyncResponse);
    socket.on("playlistUpdated", handlePlaylistUpdated);
    socket.on("playlistAdvanced", handlePlaylistAdvanced);
    socket.on("userJoined", handleUserJoined);
    socket.on("userLeft", handleUserLeft);
    socket.on("roomError", handleRoomError);
    socket.on("connect_error", handleConnectError);
    manager.on("reconnect_attempt", handleReconnectAttempt);
    manager.on("reconnect", handleReconnect);
    manager.on("reconnect_error", handleReconnectError);
    manager.on("reconnect_failed", handleReconnectFailed);

    const reconnectPulseTimer = window.setInterval(() => {
      if (socket.connected || socket.active) {
        return;
      }

      const reason = lastDisconnectReasonRef.current;
      const shouldRetryManually =
        reason === "transport close" || reason === "transport error" || reason === "ping timeout";

      if (!shouldRetryManually) {
        return;
      }

      socket.connect();
    }, RECONNECT_RETRY_PULSE_MS);

    if (!socket.connected) {
      socket.connect();
    } else {
      handleConnect();
    }

    return () => {
      window.clearTimeout(infoTimeoutRef.current);
      window.clearTimeout(reconnectResyncTimeoutRef.current);
      window.clearInterval(reconnectPulseTimer);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("roomState", handleRoomState);
      socket.off("play", handlePlay);
      socket.off("pause", handlePause);
      socket.off("seek", handleSeek);
      socket.off("syncResponse", handleSyncResponse);
      socket.off("playlistUpdated", handlePlaylistUpdated);
      socket.off("playlistAdvanced", handlePlaylistAdvanced);
      socket.off("userJoined", handleUserJoined);
      socket.off("userLeft", handleUserLeft);
      socket.off("roomError", handleRoomError);
      socket.off("connect_error", handleConnectError);
      manager.off("reconnect_attempt", handleReconnectAttempt);
      manager.off("reconnect", handleReconnect);
      manager.off("reconnect_error", handleReconnectError);
      manager.off("reconnect_failed", handleReconnectFailed);
      socket.disconnect();
    };
  }, [
    roomId,
    applySnapshotToPlayer,
    applyPresenceSnapshot,
    applyRoomMetaSnapshot,
    consumeServerNowHint,
    scheduleReconnectResync,
    showInfo,
    syncServerClock,
    updateRoomStateFromSnapshot,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        return;
      }

      socket.emit("syncRequest", { roomId, reason: "periodic" });
    }, AUTO_SYNC_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [roomId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void syncServerClock({ attempts: 1 });
    }, CLOCK_SYNC_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [syncServerClock]);

  const emitSocketEvent = useCallback((eventName, payload) => {
    const socket = socketRef.current;

    if (!socket || !socket.connected) {
      return false;
    }

    socket.emit(eventName, payload);
    return true;
  }, []);
  const requestSyncSnapshot = useCallback(
    (reason = "manual") => {
      const socket = socketRef.current;

      if (!socket || !socket.connected) {
        return;
      }

      socket.emit("syncRequest", { roomId, reason });
    },
    [roomId]
  );
  const rejectLocalControlAttempt = useCallback(() => {
    if (canControlRoom) {
      return false;
    }

    const hostLabel = hostNickname ? ` (${hostNickname})` : "";
    showInfo(`Зараз керувати може лише хост${hostLabel}.`);
    requestSyncSnapshot("host_only_local_block");
    return true;
  }, [canControlRoom, hostNickname, requestSyncSnapshot, showInfo]);

  const handleLocalPlay = useCallback(
    (currentTime) => {
      if (ignoreNextEventRef.current) {
        return;
      }

      if (rejectLocalControlAttempt()) {
        return;
      }

      const sent = emitSocketEvent("play", { roomId, currentTime });
      if (!sent) {
        return;
      }

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying: true,
              currentTime,
              stateCurrentTime: currentTime,
              updatedAt: estimateServerNowMs(),
              stateUpdatedAt: estimateServerNowMs(),
            }
          : prev
      );
    },
    [emitSocketEvent, estimateServerNowMs, rejectLocalControlAttempt, roomId]
  );

  const handleLocalPause = useCallback(
    (currentTime) => {
      if (ignoreNextEventRef.current) {
        return;
      }

      if (rejectLocalControlAttempt()) {
        return;
      }

      const sent = emitSocketEvent("pause", { roomId, currentTime });
      if (!sent) {
        return;
      }

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying: false,
              currentTime,
              stateCurrentTime: currentTime,
              updatedAt: estimateServerNowMs(),
              stateUpdatedAt: estimateServerNowMs(),
            }
          : prev
      );
    },
    [emitSocketEvent, estimateServerNowMs, rejectLocalControlAttempt, roomId]
  );

  const handleLocalSeek = useCallback(
    (currentTime) => {
      if (ignoreNextEventRef.current) {
        return;
      }

      if (rejectLocalControlAttempt()) {
        return;
      }

      const sent = emitSocketEvent("seek", { roomId, currentTime });
      if (!sent) {
        return;
      }

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              currentTime,
              stateCurrentTime: currentTime,
              updatedAt: estimateServerNowMs(),
              stateUpdatedAt: estimateServerNowMs(),
            }
          : prev
      );
    },
    [emitSocketEvent, estimateServerNowMs, rejectLocalControlAttempt, roomId]
  );

  const handlePlayerReady = useCallback(() => {
    if (roomStateRef.current) {
      applySnapshotToPlayer(roomStateRef.current, { forceSeek: true });
    }
  }, [applySnapshotToPlayer]);

  async function handleCopyRoomLink() {
    try {
      await navigator.clipboard.writeText(roomUrl);
      showInfo("Посилання скопійовано");
    } catch (copyError) {
      showInfo("Не вдалося скопіювати. Скопіюйте посилання вручну.");
    }
  }

  async function handleManualSync() {
    const socket = socketRef.current;

    if (!socket) {
      return;
    }

    if (!socket.connected) {
      setConnectionStatus("reconnecting");
      showInfo("Пробуємо відновити зʼєднання...");
      socket.connect();
      return;
    }

    await syncServerClock({ attempts: 2 });
    socket.emit("syncRequest", { roomId, reason: "manual" });
  }

  function handleToggleControlMode() {
    if (!isHost) {
      const hostLabel = hostNickname ? ` (${hostNickname})` : "";
      showInfo(`Змінювати режим може лише хост${hostLabel}.`);
      return;
    }

    const nextMode = isHostOnlyMode ? "all" : "host";
    emitSocketEvent("setControlMode", { roomId, controlMode: nextMode });
  }

  function handleLocalVideoEnded() {
    if (ignoreNextEventRef.current) {
      return;
    }

    if (rejectLocalControlAttempt()) {
      return;
    }

    const snapshot = roomStateRef.current;
    const itemId =
      snapshot?.currentItem?.itemId ||
      snapshot?.playlist?.[Number(snapshot?.currentIndex) || 0]?.itemId;

    if (!itemId) {
      return;
    }

    emitSocketEvent("videoEnded", { roomId, itemId });
  }

  async function handleAddToPlaylist(event) {
    event.preventDefault();
    setError("");

    if (rejectLocalControlAttempt()) {
      return;
    }

    const rawUrl = playlistUrlDraft.trim();
    const parsed = parseVideoUrl(rawUrl);

    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    if (playlist.length >= PLAYLIST_MAX_ITEMS) {
      setError(`Досягнуто ліміт плейлиста: ${PLAYLIST_MAX_ITEMS} відео.`);
      return;
    }

    emitSocketEvent("addToPlaylist", { roomId, videoUrl: rawUrl });
    setPlaylistUrlDraft("");
  }

  function handleSelectPlaylistItem(itemId) {
    if (!itemId) {
      return;
    }

    if (rejectLocalControlAttempt()) {
      return;
    }

    emitSocketEvent("setCurrentPlaylistItem", { roomId, itemId });
  }

  function handleRemovePlaylistItem(itemId) {
    if (!itemId) {
      return;
    }

    if (rejectLocalControlAttempt()) {
      return;
    }

    emitSocketEvent("removeFromPlaylist", { roomId, itemId });
  }

  function handleNicknameSave(event) {
    event.preventDefault();

    const safeNickname = sanitizeNickname(nicknameDraft);

    if (!safeNickname) {
      setError("Нікнейм не може бути порожнім.");
      return;
    }

    setError("");
    setNickname(safeNickname);
    setNicknameDraft(safeNickname);
    window.localStorage.setItem(NICKNAME_STORAGE_KEY, safeNickname);

    emitSocketEvent("joinRoom", { roomId, nickname: safeNickname });
    showInfo("Нікнейм оновлено");
  }

  if (loading) {
    return (
      <main className="page">
        <section className="panel loading-panel">Завантаження кімнати...</section>
      </main>
    );
  }

  if (!roomState) {
    return (
      <main className="page">
        <section className="panel">
          <h1>Кімната недоступна</h1>
          <p className="error-message">{error || "Не вдалося відкрити кімнату."}</p>
          <Link className="ghost-button" to="/">
            На головну
          </Link>
        </section>
      </main>
    );
  }

  const connectionLabel =
    connectionStatus === "connected"
      ? "Підключено"
      : connectionStatus === "reconnecting"
        ? "Відновлення..."
      : connectionStatus === "connecting"
        ? "Підключення..."
        : "Втрачено зʼєднання";
  const displayedUsersCount = sortedParticipants.length || usersCount;

  return (
    <main className="page page-room">
      <section className="panel room-panel">
        <div className="room-head">
          <div>
            <p className="eyebrow">Кімната перегляду</p>
            <h1>Room ID: {roomState.roomId}</h1>
          </div>
          <span
            className={`connection-pill ${
              connectionStatus === "connected"
                ? "online"
                : connectionStatus === "reconnecting"
                  ? "reconnecting"
                  : "offline"
            }`}
          >
            {connectionLabel}
          </span>
        </div>

        <div className="room-link-block">
          <input readOnly value={roomUrl} />
          <button type="button" onClick={handleCopyRoomLink}>
            Скопіювати
          </button>
        </div>

        <div className="room-stats">
          <span>Учасників онлайн: {displayedUsersCount}</span>
          <span>Тип відео: {roomState.videoType === "youtube" ? "YouTube" : "MP4"}</span>
          <span>
            Трек: {playlist.length > 0 ? currentPlaylistIndex + 1 : 0}/{playlist.length}
          </span>
          <span>Режим: {isHostOnlyMode ? "Керує тільки хост" : "Керують усі"}</span>
          <span>Хост: {hostNickname || "Ще не визначено"}</span>
        </div>

        <form className="nickname-form" onSubmit={handleNicknameSave}>
          <label htmlFor="roomNickname">Ваш нікнейм</label>
          <div className="nickname-row">
            <input
              id="roomNickname"
              type="text"
              value={nicknameDraft}
              onChange={(event) => setNicknameDraft(event.target.value)}
              placeholder="Введіть свій нікнейм"
              maxLength={MAX_NICKNAME_LENGTH}
            />
            <button type="submit">Оновити</button>
          </div>
        </form>

        <div className="room-actions">
          <button type="button" onClick={handleManualSync}>
            Синхронізуватися з хостом
          </button>
          <button type="button" className="ghost-button" onClick={handleToggleControlMode}>
            {isHostOnlyMode ? "Дозволити керування всім" : "Увімкнути режим хоста"}
          </button>
          <Link className="ghost-button" to="/">
            Нова кімната
          </Link>
        </div>
        {isHostOnlyMode && !isHost ? (
          <p className="control-hint">
            Режим "керує тільки хост". Ви можете дивитися, але не керувати відтворенням і
            плейлистом.
          </p>
        ) : null}

        <section className="playlist-panel">
          <h2>Плейлист кімнати</h2>

          <form className="playlist-form" onSubmit={handleAddToPlaylist}>
            <label htmlFor="playlistVideoUrl">Додати відео в чергу</label>
            <div className="playlist-form-row">
              <input
                id="playlistVideoUrl"
                type="url"
                placeholder="https://www.youtube.com/watch?v=... або https://site.com/video.mp4"
                value={playlistUrlDraft}
                onChange={(event) => setPlaylistUrlDraft(event.target.value)}
                autoComplete="off"
                disabled={!canControlRoom}
              />
              <button type="submit" disabled={!playlistUrlDraft.trim() || !canControlRoom}>
                Додати
              </button>
            </div>
          </form>

          {playlist.length === 0 ? (
            <p className="playlist-empty">Плейлист поки порожній.</p>
          ) : (
            <ul className="playlist-list">
              {playlist.map((item, index) => {
                const isCurrent = currentPlaylistItem?.itemId === item.itemId;

                return (
                  <li key={item.itemId} className={isCurrent ? "is-current" : ""}>
                    <button
                      type="button"
                      className="playlist-item-main"
                      onClick={() => handleSelectPlaylistItem(item.itemId)}
                      disabled={!canControlRoom}
                    >
                      <span className="playlist-item-title">
                        {index + 1}. {item.videoType === "youtube" ? "YouTube" : "MP4"}
                      </span>
                      <span className="playlist-item-url">{item.videoUrl}</span>
                      {item.addedBy ? (
                        <span className="playlist-item-meta">Додав: {item.addedBy}</span>
                      ) : null}
                    </button>

                    <div className="playlist-item-actions">
                      {isCurrent ? <span className="playlist-current-badge">Зараз грає</span> : null}
                      <button
                        type="button"
                        className="ghost-button playlist-remove-button"
                        onClick={() => handleRemovePlaylistItem(item.itemId)}
                        disabled={playlist.length <= 1 || !canControlRoom}
                      >
                        Видалити
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="participants-panel">
          <h2>Учасники кімнати</h2>
          {sortedParticipants.length === 0 ? (
            <p className="participants-empty">Поки що нікого немає в кімнаті.</p>
          ) : (
            <ul className="participants-list">
              {sortedParticipants.map((participant) => {
                const isCurrentUser = participant.socketId === socketRef.current?.id;
                const isHostParticipant = participant.socketId === hostSocketId;

                return (
                  <li key={participant.socketId} className={isHostParticipant ? "is-host" : ""}>
                    <span>{participant.nickname}</span>
                    <span className="participant-tags">
                      {isHostParticipant ? <span className="participant-host">Хост</span> : null}
                      {isCurrentUser ? <span className="participant-self">(Ви)</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {infoMessage ? <p className="info-message">{infoMessage}</p> : null}
        {error ? <p className="error-message">{error}</p> : null}
      </section>

      <section className="panel video-panel">
        <div className="video-player-wrap">
          <VideoPlayer
            ref={playerRef}
            videoType={roomState.videoType}
            videoUrl={roomState.videoUrl}
            videoId={roomState.videoId}
            ignoreEventsRef={ignoreNextEventRef}
            onPlay={handleLocalPlay}
            onPause={handleLocalPause}
            onSeek={handleLocalSeek}
            onEnded={handleLocalVideoEnded}
            onReady={handlePlayerReady}
            onError={setError}
          />
          {isHostOnlyMode && !isHost ? (
            <div className="video-control-lock" aria-hidden="true">
              <span>Керування заблоковано: лише хост</span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export default Room;
