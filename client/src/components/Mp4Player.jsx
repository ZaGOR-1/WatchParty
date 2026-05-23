import { forwardRef, useImperativeHandle, useRef } from "react";

const Mp4Player = forwardRef(function Mp4Player(
  { videoUrl, ignoreEventsRef, onPlay, onPause, onSeek, onEnded, onReady, onError },
  ref
) {
  const videoRef = useRef(null);

  useImperativeHandle(
    ref,
    () => ({
      play: async (time) => {
        if (!videoRef.current) {
          return;
        }

        if (Number.isFinite(time)) {
          videoRef.current.currentTime = Math.max(0, time);
        }

        try {
          await videoRef.current.play();
        } catch (error) {
          // Browser autoplay policies can block programmatic play.
        }
      },
      pause: (time) => {
        if (!videoRef.current) {
          return;
        }

        if (Number.isFinite(time)) {
          videoRef.current.currentTime = Math.max(0, time);
        }

        videoRef.current.pause();
      },
      seekTo: (time) => {
        if (!videoRef.current || !Number.isFinite(time)) {
          return;
        }

        videoRef.current.currentTime = Math.max(0, time);
      },
      getCurrentTime: () => {
        if (!videoRef.current) {
          return 0;
        }

        return Number(videoRef.current.currentTime || 0);
      },
    }),
    []
  );

  const handlePlay = () => {
    if (ignoreEventsRef.current) {
      return;
    }

    onPlay?.(videoRef.current?.currentTime || 0);
  };

  const handlePause = () => {
    if (ignoreEventsRef.current) {
      return;
    }

    onPause?.(videoRef.current?.currentTime || 0);
  };

  const handleSeeked = () => {
    if (ignoreEventsRef.current) {
      return;
    }

    onSeek?.(videoRef.current?.currentTime || 0);
  };

  const handleEnded = () => {
    if (ignoreEventsRef.current) {
      return;
    }

    onEnded?.();
  };

  return (
    <div className="player-frame">
      <video
        ref={videoRef}
        className="player-video"
        src={videoUrl}
        controls
        playsInline
        onLoadedMetadata={onReady}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={handleSeeked}
        onEnded={handleEnded}
        onError={() => onError?.("Не вдалося відтворити MP4. Перевірте посилання.")}
      />
    </div>
  );
});

export default Mp4Player;
