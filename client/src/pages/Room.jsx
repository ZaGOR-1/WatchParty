import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import VideoPlayer from "../components/VideoPlayer";
import { getSocket } from "../socket";

const REMOTE_ACTION_LOCK_MS = 1200;
const AUTO_SYNC_INTERVAL_MS = 7000;
const DRIFT_THRESHOLD_SEC = 1.25;

function Room() {
  const { roomId } = useParams();
  const [loading, setLoading] = useState(true);
  const [roomState, setRoomState] = useState(null);
  const [usersCount, setUsersCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");

  const playerRef = useRef(null);
  const socketRef = useRef(null);
  const roomStateRef = useRef(null);
  const ignoreNextEventRef = useRef(false);
  const infoTimeoutRef = useRef(null);

  const roomUrl = useMemo(
    () => `${window.location.origin}/room/${roomId}`,
    [roomId]
  );

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  const showInfo = useCallback((message) => {
    setInfoMessage(message);
    window.clearTimeout(infoTimeoutRef.current);
    infoTimeoutRef.current = window.setTimeout(() => setInfoMessage(""), 2500);
  }, []);

  const withRemoteLock = useCallback((action) => {
    ignoreNextEventRef.current = true;
    action();
    window.setTimeout(() => {
      ignoreNextEventRef.current = false;
    }, REMOTE_ACTION_LOCK_MS);
  }, []);

  const applySnapshotToPlayer = useCallback(
    (snapshot, forceSeek = false) => {
      if (!snapshot || !playerRef.current) {
        return;
      }

      withRemoteLock(() => {
        const player = playerRef.current;
        const localTime = Number(player.getCurrentTime?.() || 0);
        const targetTime = Number(snapshot.currentTime || 0);
        const drift = Math.abs(localTime - targetTime);

        if (forceSeek || drift > DRIFT_THRESHOLD_SEC) {
          player.seekTo?.(targetTime);
        }

        if (snapshot.isPlaying) {
          player.play?.(targetTime);
        } else {
          player.pause?.(targetTime);
        }
      });
    },
    [withRemoteLock]
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
    socketRef.current = socket;

    const handleConnect = () => {
      setConnectionStatus("connected");
      socket.emit("joinRoom", { roomId });
    };

    const handleDisconnect = () => {
      setConnectionStatus("disconnected");
    };

    const handleRoomState = (snapshot) => {
      setRoomState(snapshot);
      setUsersCount(snapshot.usersCount || 0);
      applySnapshotToPlayer(snapshot, true);
    };

    const handlePlay = (payload) => {
      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying: true,
              currentTime: payload.currentTime,
              updatedAt: Date.now(),
            }
          : prev
      );

      applySnapshotToPlayer(
        {
          currentTime: payload.currentTime,
          isPlaying: true,
        },
        true
      );
    };

    const handlePause = (payload) => {
      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying: false,
              currentTime: payload.currentTime,
              updatedAt: Date.now(),
            }
          : prev
      );

      applySnapshotToPlayer(
        {
          currentTime: payload.currentTime,
          isPlaying: false,
        },
        true
      );
    };

    const handleSeek = (payload) => {
      const isPlaying =
        typeof payload.isPlaying === "boolean"
          ? payload.isPlaying
          : roomStateRef.current?.isPlaying || false;

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying,
              currentTime: payload.currentTime,
              updatedAt: Date.now(),
            }
          : prev
      );

      applySnapshotToPlayer(
        {
          currentTime: payload.currentTime,
          isPlaying,
        },
        true
      );
    };

    const handleSyncResponse = (snapshot) => {
      setRoomState(snapshot);
      setUsersCount(snapshot.usersCount || 0);
      applySnapshotToPlayer(snapshot, true);
      showInfo("Синхронізація виконана");
    };

    const handleUserJoined = ({ usersCount: count }) => {
      setUsersCount(count || 0);
    };

    const handleUserLeft = ({ usersCount: count }) => {
      setUsersCount(count || 0);
    };

    const handleRoomError = ({ message }) => {
      setError(message || "Помилка роботи з кімнатою.");
    };

    const handleConnectError = (connectionError) => {
      setConnectionStatus("disconnected");
      setError(connectionError.message || "Втрачено з’єднання із сервером.");
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("roomState", handleRoomState);
    socket.on("play", handlePlay);
    socket.on("pause", handlePause);
    socket.on("seek", handleSeek);
    socket.on("syncResponse", handleSyncResponse);
    socket.on("userJoined", handleUserJoined);
    socket.on("userLeft", handleUserLeft);
    socket.on("roomError", handleRoomError);
    socket.on("connect_error", handleConnectError);

    if (!socket.connected) {
      socket.connect();
    } else {
      handleConnect();
    }

    return () => {
      window.clearTimeout(infoTimeoutRef.current);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("roomState", handleRoomState);
      socket.off("play", handlePlay);
      socket.off("pause", handlePause);
      socket.off("seek", handleSeek);
      socket.off("syncResponse", handleSyncResponse);
      socket.off("userJoined", handleUserJoined);
      socket.off("userLeft", handleUserLeft);
      socket.off("roomError", handleRoomError);
      socket.off("connect_error", handleConnectError);
      socket.disconnect();
    };
  }, [roomId, applySnapshotToPlayer, showInfo]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        return;
      }

      socket.emit("syncRequest", { roomId });
    }, AUTO_SYNC_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [roomId]);

  const emitSocketEvent = useCallback((eventName, payload) => {
    const socket = socketRef.current;

    if (!socket || !socket.connected) {
      return;
    }

    socket.emit(eventName, payload);
  }, []);

  const handleLocalPlay = useCallback(
    (currentTime) => {
      if (ignoreNextEventRef.current) {
        return;
      }

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying: true,
              currentTime,
              updatedAt: Date.now(),
            }
          : prev
      );

      emitSocketEvent("play", { roomId, currentTime });
    },
    [emitSocketEvent, roomId]
  );

  const handleLocalPause = useCallback(
    (currentTime) => {
      if (ignoreNextEventRef.current) {
        return;
      }

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              isPlaying: false,
              currentTime,
              updatedAt: Date.now(),
            }
          : prev
      );

      emitSocketEvent("pause", { roomId, currentTime });
    },
    [emitSocketEvent, roomId]
  );

  const handleLocalSeek = useCallback(
    (currentTime) => {
      if (ignoreNextEventRef.current) {
        return;
      }

      setRoomState((prev) =>
        prev
          ? {
              ...prev,
              currentTime,
              updatedAt: Date.now(),
            }
          : prev
      );

      emitSocketEvent("seek", { roomId, currentTime });
    },
    [emitSocketEvent, roomId]
  );

  const handlePlayerReady = useCallback(() => {
    if (roomStateRef.current) {
      applySnapshotToPlayer(roomStateRef.current, true);
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

  function handleManualSync() {
    emitSocketEvent("syncRequest", { roomId });
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
      : connectionStatus === "connecting"
        ? "Підключення..."
        : "Втрачено зʼєднання";

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
              connectionStatus === "connected" ? "online" : "offline"
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
          <span>Учасників онлайн: {usersCount}</span>
          <span>Тип відео: {roomState.videoType === "youtube" ? "YouTube" : "MP4"}</span>
        </div>

        <div className="room-actions">
          <button type="button" onClick={handleManualSync}>
            Синхронізуватися з хостом
          </button>
          <Link className="ghost-button" to="/">
            Нова кімната
          </Link>
        </div>

        {infoMessage ? <p className="info-message">{infoMessage}</p> : null}
        {error ? <p className="error-message">{error}</p> : null}
      </section>

      <section className="panel video-panel">
        <VideoPlayer
          ref={playerRef}
          videoType={roomState.videoType}
          videoUrl={roomState.videoUrl}
          videoId={roomState.videoId}
          ignoreEventsRef={ignoreNextEventRef}
          onPlay={handleLocalPlay}
          onPause={handleLocalPause}
          onSeek={handleLocalSeek}
          onReady={handlePlayerReady}
          onError={setError}
        />
      </section>
    </main>
  );
}

export default Room;
