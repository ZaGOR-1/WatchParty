import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

let youtubeApiPromise;

function loadYoutubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-youtube-api="true"]');

    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.youtubeApi = "true";
      script.onerror = () => reject(new Error("Не вдалося завантажити YouTube API."));
      document.body.appendChild(script);
    }

    window.onYouTubeIframeAPIReady = () => resolve(window.YT);

    const maxWaitTimer = window.setTimeout(() => {
      if (!window.YT?.Player) {
        reject(new Error("YouTube API не відповідає."));
      }
    }, 12000);

    const readyPoller = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(readyPoller);
        window.clearTimeout(maxWaitTimer);
        resolve(window.YT);
      }
    }, 250);
  });

  return youtubeApiPromise;
}

const YoutubePlayer = forwardRef(function YoutubePlayer(
  { videoId, ignoreEventsRef, onPlay, onPause, onSeek, onReady, onError },
  ref
) {
  const elementId = useMemo(
    () => `youtube-player-${Math.random().toString(36).slice(2, 10)}`,
    []
  );
  const playerRef = useRef(null);
  const seekWatcherRef = useRef(null);
  const lastKnownTimeRef = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      play: (time) => {
        const player = playerRef.current;

        if (!player) {
          return;
        }

        if (Number.isFinite(time)) {
          const safeTime = Math.max(0, time);
          lastKnownTimeRef.current = safeTime;
          player.seekTo(safeTime, true);
        }

        player.playVideo();
      },
      pause: (time) => {
        const player = playerRef.current;

        if (!player) {
          return;
        }

        if (Number.isFinite(time)) {
          const safeTime = Math.max(0, time);
          lastKnownTimeRef.current = safeTime;
          player.seekTo(safeTime, true);
        }

        const state =
          typeof player.getPlayerState === "function" ? player.getPlayerState() : null;
        const isActivePlaybackState =
          state === window.YT?.PlayerState?.PLAYING ||
          state === window.YT?.PlayerState?.BUFFERING;

        // Якщо pause викликати в UNSTARTED стані, YouTube інколи показує чорний кадр.
        if (isActivePlaybackState) {
          player.pauseVideo();
        }
      },
      seekTo: (time) => {
        const player = playerRef.current;

        if (!player || !Number.isFinite(time)) {
          return;
        }

        const safeTime = Math.max(0, time);
        lastKnownTimeRef.current = safeTime;
        player.seekTo(safeTime, true);
      },
      getCurrentTime: () => {
        const player = playerRef.current;

        if (!player || typeof player.getCurrentTime !== "function") {
          return 0;
        }

        return Number(player.getCurrentTime() || 0);
      },
    }),
    []
  );

  useEffect(() => {
    let disposed = false;

    async function bootPlayer() {
      try {
        await loadYoutubeApi();

        if (disposed || !window.YT?.Player) {
          return;
        }

        const player = new window.YT.Player(elementId, {
          videoId,
          playerVars: {
            rel: 0,
            controls: 1,
            modestbranding: 1,
            playsinline: 1,
          },
          events: {
            onReady: () => {
              if (disposed) {
                return;
              }

              lastKnownTimeRef.current = 0;
              onReady?.();
            },
            onStateChange: (event) => {
              if (ignoreEventsRef.current || disposed) {
                return;
              }

              const currentTime = Number(player.getCurrentTime() || 0);

              if (event.data === window.YT.PlayerState.PLAYING) {
                onPlay?.(currentTime);
              } else if (event.data === window.YT.PlayerState.PAUSED) {
                onPause?.(currentTime);
              }
            },
            onError: (event) => {
              const code = event?.data;
              const messageByCode = {
                2: "YouTube: некоректний videoId у посиланні.",
                5: "YouTube: помилка HTML5 плеєра для цього відео.",
                100: "YouTube: відео не знайдено або воно приватне.",
                101: "YouTube: власник заборонив вбудовування цього відео.",
                150: "YouTube: власник заборонив вбудовування цього відео.",
                153: "YouTube: запит без коректного referrer/origin (помилка 153).",
              };

              onError?.(
                messageByCode[code] ||
                  `Не вдалося відтворити YouTube-відео (код помилки: ${code ?? "unknown"}).`
              );
            },
          },
        });

        playerRef.current = player;

        // YouTube API не має окремого seek event, тому відслідковуємо стрибки часу.
        seekWatcherRef.current = window.setInterval(() => {
          if (disposed || !playerRef.current) {
            return;
          }

          const currentTime = Number(playerRef.current.getCurrentTime() || 0);
          if (ignoreEventsRef.current) {
            lastKnownTimeRef.current = currentTime;
            return;
          }

          const drift = Math.abs(currentTime - lastKnownTimeRef.current);

          if (drift > 1.4) {
            onSeek?.(currentTime);
          }

          lastKnownTimeRef.current = currentTime;
        }, 700);
      } catch (error) {
        onError?.("Не вдалося ініціалізувати YouTube player.");
      }
    }

    bootPlayer();

    return () => {
      disposed = true;

      if (seekWatcherRef.current) {
        window.clearInterval(seekWatcherRef.current);
      }

      if (playerRef.current && typeof playerRef.current.destroy === "function") {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [elementId, videoId, ignoreEventsRef, onPlay, onPause, onSeek, onReady, onError]);

  return (
    <div className="player-frame">
      <div id={elementId} className="player-youtube" />
    </div>
  );
});

export default YoutubePlayer;
