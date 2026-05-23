import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseVideoUrl } from "../utils/videoParser";

const NICKNAME_STORAGE_KEY = "watchparty:nickname";
const MAX_NICKNAME_LENGTH = 24;

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

function Home() {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(() => getStoredNickname());
  const [videoUrlsText, setVideoUrlsText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState([]);

  function parseVideoUrlsInput(rawInput) {
    return String(rawInput || "")
      .split(/\r?\n|,/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async function handleCreateRoom(event) {
    event.preventDefault();
    setError("");
    setErrorDetails([]);

    const safeNickname = sanitizeNickname(nickname);
    if (!safeNickname) {
      setError("Введіть свій нікнейм перед створенням кімнати.");
      return;
    }

    const videoUrls = parseVideoUrlsInput(videoUrlsText);

    if (videoUrls.length === 0) {
      setError("Додайте хоча б одне посилання на відео.");
      return;
    }

    if (videoUrls.length > 50) {
      setError("Для MVP доступно максимум 50 відео у стартовому плейлисті.");
      return;
    }

    for (const url of videoUrls) {
      const parsed = parseVideoUrl(url);

      if (parsed.error) {
        setError(parsed.error);
        return;
      }
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          videoUrls,
        }),
      });

      let data = {};
      try {
        data = await response.json();
      } catch (parseError) {
        data = {};
      }

      if (!response.ok) {
        const apiError = new Error(data.message || "Не вдалося створити кімнату.");
        apiError.details = Array.isArray(data.details) ? data.details : [];
        throw apiError;
      }

      window.localStorage.setItem(NICKNAME_STORAGE_KEY, safeNickname);
      navigate(data.url);
    } catch (requestError) {
      setError(requestError.message || "Помилка запиту до сервера.");
      setErrorDetails(Array.isArray(requestError.details) ? requestError.details : []);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="page page-home">
      <section className="panel hero-panel">
        <p className="eyebrow">Синхронний перегляд для друзів</p>
        <h1>Zagor Watch Party</h1>
        <p className="subtitle">
          Вставте одне або кілька YouTube/MP4 посилань, створіть кімнату й дивіться
          відео разом у реальному часі.
        </p>

        <form className="create-room-form" onSubmit={handleCreateRoom}>
          <label htmlFor="nickname">Ваш нікнейм</label>
          <input
            id="nickname"
            type="text"
            placeholder="Наприклад: Zagor"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            autoComplete="nickname"
            maxLength={MAX_NICKNAME_LENGTH}
            required
          />

          <label htmlFor="videoUrls">Посилання на відео (по одному в рядку)</label>
          <textarea
            id="videoUrls"
            placeholder={
              "https://www.youtube.com/watch?v=...\nhttps://site.com/video.mp4\nhttps://youtu.be/..."
            }
            value={videoUrlsText}
            onChange={(event) => setVideoUrlsText(event.target.value)}
            rows={4}
            required
          />
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Створюємо..." : "Створити кімнату"}
          </button>
        </form>

        {error ? (
          <div className="error-message">
            <p>{error}</p>
            {errorDetails.length > 0 ? (
              <ul className="error-details">
                {errorDetails.map((detail, index) => (
                  <li key={`${detail}-${index}`}>{detail}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="support-note">
          <strong>Підтримка MVP:</strong> YouTube через IFrame API та прямі легальні .mp4
          посилання.
        </div>
      </section>
    </main>
  );
}

export default Home;
