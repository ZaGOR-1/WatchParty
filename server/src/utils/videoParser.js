function isYouTubeWatchHost(hostname) {
  return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
}

function isYouTubeShortHost(hostname) {
  return hostname === "youtu.be" || hostname === "www.youtu.be";
}

function extractYouTubeVideoId(urlObject) {
  const hostname = urlObject.hostname.toLowerCase();

  if (isYouTubeShortHost(hostname)) {
    const shortId = urlObject.pathname.split("/").filter(Boolean)[0];
    return shortId || null;
  }

  if (isYouTubeWatchHost(hostname)) {
    if (urlObject.pathname === "/watch") {
      return urlObject.searchParams.get("v");
    }

    if (urlObject.pathname.startsWith("/embed/")) {
      const embedId = urlObject.pathname.split("/")[2];
      return embedId || null;
    }
  }

  return null;
}

function parseVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { error: "Передайте коректне посилання на відео." };
  }

  let urlObject;

  try {
    urlObject = new URL(rawUrl.trim());
  } catch (error) {
    return { error: "Некоректний формат URL." };
  }

  if (!["http:", "https:"].includes(urlObject.protocol)) {
    return { error: "Підтримуються лише http/https посилання." };
  }

  const hostname = urlObject.hostname.toLowerCase();
  const isYouTubeHost = isYouTubeShortHost(hostname) || isYouTubeWatchHost(hostname);

  if (isYouTubeHost) {
    const videoId = extractYouTubeVideoId(urlObject);

    if (!videoId) {
      return {
        error:
          "Не вдалося знайти YouTube videoId. Використайте формат youtube.com/watch?v=... або youtu.be/...",
      };
    }

    return {
      videoType: "youtube",
      videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  if (urlObject.pathname.toLowerCase().endsWith(".mp4")) {
    return {
      videoType: "mp4",
      videoId: null,
      normalizedUrl: urlObject.toString(),
    };
  }

  return {
    error: "Підтримуються лише YouTube-посилання та прямі .mp4 URL.",
  };
}

module.exports = {
  parseVideoUrl,
};
