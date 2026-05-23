import { forwardRef } from "react";
import YoutubePlayer from "./YoutubePlayer";
import Mp4Player from "./Mp4Player";

const VideoPlayer = forwardRef(function VideoPlayer(
  {
    videoType,
    videoUrl,
    videoId,
    ignoreEventsRef,
    onPlay,
    onPause,
    onSeek,
    onReady,
    onError,
  },
  ref
) {
  if (videoType === "youtube") {
    return (
      <YoutubePlayer
        ref={ref}
        videoId={videoId}
        ignoreEventsRef={ignoreEventsRef}
        onPlay={onPlay}
        onPause={onPause}
        onSeek={onSeek}
        onReady={onReady}
        onError={onError}
      />
    );
  }

  if (videoType === "mp4") {
    return (
      <Mp4Player
        ref={ref}
        videoUrl={videoUrl}
        ignoreEventsRef={ignoreEventsRef}
        onPlay={onPlay}
        onPause={onPause}
        onSeek={onSeek}
        onReady={onReady}
        onError={onError}
      />
    );
  }

  return (
    <div className="unsupported-message">
      Непідтримуваний тип відео. Доступні лише YouTube або прямі .mp4.
    </div>
  );
});

export default VideoPlayer;

