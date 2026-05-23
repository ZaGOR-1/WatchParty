const DEFAULT_TIMEOUT_MS = Number(process.env.MP4_PROBE_TIMEOUT_MS || 8000);
const RANGE_HEADER_VALUE = "bytes=0-1";

function stopResponseStream(response) {
  if (response?.body && typeof response.body.cancel === "function") {
    response.body.cancel().catch(() => {});
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: abortController.signal,
      redirect: "follow",
    });

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function buildResult(ok, message, details) {
  return {
    ok,
    message,
    details,
  };
}

function appendHeadDetails(details, response) {
  details.push(`HEAD статус: ${response.status}`);

  const contentType = response.headers.get("content-type");
  if (contentType) {
    details.push(`Content-Type: ${contentType}`);
  } else {
    details.push("Content-Type: не вказано");
  }

  const acceptRanges = response.headers.get("accept-ranges");
  if (acceptRanges) {
    details.push(`Accept-Ranges: ${acceptRanges}`);
  } else {
    details.push("Accept-Ranges: не вказано");
  }
}

function mapHeadStatusError(status) {
  if (status === 401 || status === 403) {
    return "Джерело MP4 відхиляє доступ (401/403). Можливі anti-hotlink або потрібна авторизація.";
  }

  if (status === 404) {
    return "MP4 ресурс не знайдено (404).";
  }

  if (status >= 400) {
    return `Джерело MP4 повернуло HTTP ${status} на HEAD-запит.`;
  }

  return null;
}

function validateContentType(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (!contentType) {
    return null;
  }

  if (contentType.includes("video/mp4")) {
    return null;
  }

  if (contentType.includes("application/octet-stream")) {
    return null;
  }

  if (contentType.startsWith("video/")) {
    return `Сервер віддає інший відеоформат (${contentType}), очікується video/mp4.`;
  }

  return `Сервер повернув не відео-MP4 контент (${contentType}).`;
}

function mapRangeStatusError(status) {
  if (status === 401 || status === 403) {
    return "Range-запит відхилено (401/403). Це блокує стабільну перемотку.";
  }

  if (status === 404) {
    return "Range-запит повернув 404. Схоже, що MP4 URL недійсний.";
  }

  if (status === 200) {
    return "Сервер ігнорує Range-запити (повертає 200 замість 206), перемотка може не працювати.";
  }

  if (status === 416) {
    return "Сервер повернув 416 (Range Not Satisfiable). MP4 ресурс не підтримує очікуваний діапазон.";
  }

  if (status >= 400) {
    return `Range-перевірка повернула HTTP ${status}.`;
  }

  return null;
}

async function validateMp4Url(videoUrl) {
  const details = [];

  let headResponse;
  try {
    headResponse = await fetchWithTimeout(videoUrl, { method: "HEAD" });
  } catch (error) {
    if (error?.code) {
      details.push(`Код помилки мережі: ${error.code}`);
    }
    if (error?.message) {
      details.push(`Повідомлення: ${error.message}`);
    }

    const reason =
      error?.name === "AbortError"
        ? "таймаут HEAD-запиту"
        : "мережева помилка під час HEAD-запиту";
    return buildResult(false, `Не вдалося перевірити MP4 URL: ${reason}.`, details);
  }

  appendHeadDetails(details, headResponse);
  if (headResponse.url && headResponse.url !== videoUrl) {
    details.push(`Фінальний URL після редіректів: ${headResponse.url}`);
  }

  const headStatusError = mapHeadStatusError(headResponse.status);
  if (headStatusError) {
    stopResponseStream(headResponse);
    return buildResult(false, headStatusError, details);
  }

  const contentTypeError = validateContentType(headResponse);
  if (contentTypeError) {
    stopResponseStream(headResponse);
    return buildResult(false, contentTypeError, details);
  }

  stopResponseStream(headResponse);

  let rangeResponse;
  try {
    rangeResponse = await fetchWithTimeout(videoUrl, {
      method: "GET",
      headers: {
        Range: RANGE_HEADER_VALUE,
      },
    });
  } catch (error) {
    if (error?.code) {
      details.push(`Код помилки мережі: ${error.code}`);
    }
    if (error?.message) {
      details.push(`Повідомлення: ${error.message}`);
    }

    const reason =
      error?.name === "AbortError"
        ? "таймаут Range-запиту"
        : "мережева помилка під час Range-запиту";
    return buildResult(false, `Не вдалося виконати Range-перевірку MP4: ${reason}.`, details);
  }

  details.push(`Range перевірка (bytes=0-1): HTTP ${rangeResponse.status}`);
  stopResponseStream(rangeResponse);

  if (rangeResponse.status !== 206) {
    const rangeError = mapRangeStatusError(rangeResponse.status);
    return buildResult(
      false,
      rangeError || "Сервер не підтвердив підтримку byte-range для MP4.",
      details
    );
  }

  return buildResult(true, "MP4 URL пройшов перевірку.", details);
}

module.exports = {
  validateMp4Url,
};
