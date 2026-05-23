import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseVideoUrl } from "../utils/videoParser";

function Home() {
  const navigate = useNavigate();
  const [videoUrl, setVideoUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState([]);

  async function handleCreateRoom(event) {
    event.preventDefault();
    setError("");
    setErrorDetails([]);

    const parsed = parseVideoUrl(videoUrl);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ videoUrl: videoUrl.trim() }),
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
          Вставте YouTube або прямий MP4 URL, створіть кімнату й дивіться відео разом у
          реальному часі.
        </p>

        <form className="create-room-form" onSubmit={handleCreateRoom}>
          <label htmlFor="videoUrl">Посилання на відео</label>
          <input
            id="videoUrl"
            type="url"
            placeholder="https://www.youtube.com/watch?v=... або https://site.com/video.mp4"
            value={videoUrl}
            onChange={(event) => setVideoUrl(event.target.value)}
            autoComplete="off"
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
