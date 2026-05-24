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

export function parseVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { error: "Введіть посилання на відео." };
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
          "YouTube-посилання має містити videoId (youtube.com/watch?v=... або youtu.be/...).",
      };
    }
  }

  if (isYouTubeHost || urlObject.pathname.toLowerCase().endsWith(".mp4")) {
    return { ok: true };
  }

  return {
    error: "Підтримуються лише YouTube-посилання та прямі .mp4 URL.",
  };
}
