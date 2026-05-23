# Zagor Watch Party (MVP)

MVP вебсервісу для синхронного перегляду одного відео кількома людьми в кімнаті.
Один учасник натискає `Play`, `Pause` або `Seek` і ця дія повторюється в інших учасників через Socket.IO.

## Можливості MVP

- Створення кімнати за відео-посиланням.
- Формат кімнати: `/room/:roomId`.
- Підтримка джерел:
  - YouTube (`youtube.com/watch?v=...` або `youtu.be/...`)
  - прямі `.mp4` URL
- Для `.mp4` виконується перевірка доступності на backend:
  - `HEAD` перевірка статусу/`Content-Type`
  - `Range` перевірка (`bytes=0-1`) для стабільної перемотки
  - при помилці повертається деталізована причина
  - перевірку можна вимкнути через `MP4_PROBE_ENABLED=false`
- Синхронізація у реальному часі подій:
  - `joinRoom`
  - `roomState`
  - `play`
  - `pause`
  - `seek`
  - `syncRequest`
  - `syncResponse`
  - `userJoined`
  - `userLeft`
- Показ:
  - посилання на кімнату + кнопка копіювання
  - кількість підключених користувачів
  - стан з’єднання Socket.IO
- Авто-синхронізація кожні ~7 секунд для корекції дрейфу.
- Ручна кнопка “Синхронізуватися з хостом”.
- Очищення порожніх кімнат через TTL.

## Технологічний стек

- Frontend: React + Vite (JavaScript)
- Backend: Node.js + Express
- Realtime: Socket.IO
- Reverse proxy: Nginx
- TLS/публічний вхід (VPS): Caddy
- Контейнеризація: Docker + Docker Compose
- Зберігання стану: in-memory (без БД на етапі MVP)

## Структура проєкту

```text
watch-party/
  client/
    Dockerfile
    package.json
    vite.config.js
    index.html
    src/
      main.jsx
      App.jsx
      pages/
        Home.jsx
        Room.jsx
      components/
        VideoPlayer.jsx
        YoutubePlayer.jsx
        Mp4Player.jsx
      socket.js
      utils/
        videoParser.js
      styles/
        global.css

  server/
    Dockerfile
    package.json
    src/
      index.js
      rooms.js
      utils/
        videoParser.js

  nginx/
    default.conf

  caddy/
    Caddyfile

  docker-compose.yml
  docker-compose.vps.yml
  .env.example
  README.md
```

## Стан кімнати на backend

Для кожної кімнати зберігається:

- `roomId`
- `videoUrl`
- `videoType` (`youtube` або `mp4`)
- `videoId` (для YouTube)
- `isPlaying`
- `currentTime`
- `updatedAt`
- `usersCount`

Якщо `isPlaying = true`, актуальний час при читанні стану оцінюється як:

`currentTime + (Date.now() - updatedAt) / 1000`

## HTTP API

### `POST /api/rooms`

Body:

```json
{
  "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

Response:

```json
{
  "roomId": "abc123",
  "url": "/room/abc123"
}
```

### `GET /api/rooms/:roomId`

Response:

```json
{
  "roomId": "abc123",
  "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "videoType": "youtube",
  "videoId": "dQw4w9WgXcQ",
  "isPlaying": false,
  "currentTime": 0,
  "updatedAt": 1710000000000,
  "usersCount": 2
}
```

## Запуск локально без Docker

### 1) Підготовка

1. Скопіюйте `.env.example` у `.env`.
2. Встановіть Node.js 20+.

### Швидкий запуск однією командою (рекомендовано)

```bash
cd watch-party
npm install
npm run install:all
npm run dev
```

Після цього:

- backend працює на `http://localhost:4000`
- frontend працює на `http://localhost:5173`
- обидва процеси зупиняються через `Ctrl + C` в одному вікні терміналу

Якщо порти зайняті після аварійного завершення (`EADDRINUSE`), використайте:

```bash
npm run stop:dev
npm run dev
```

Або одразу:

```bash
npm run dev:fresh
```

### 2) Запуск backend

```bash
cd server
npm install
npm run dev
```

Backend за замовчуванням: `http://localhost:4000`

### 3) Запуск frontend

В іншому терміналі:

```bash
cd client
npm install
npm run dev
```

Frontend за замовчуванням: `http://localhost:5173`

> Vite proxy автоматично проксуює `/api` і `/socket.io` на backend.

## Запуск через Docker Compose

### 1) Підготовка

1. Скопіюйте `.env.example` у `.env`.
2. Переконайтеся, що Docker та Docker Compose встановлені.

### 2) Локальний запуск (без домену)

```bash
docker compose up --build
```

Після старту відкрийте:

- `http://localhost:8080` (або порт із `NGINX_PORT` у `.env`)

### 3) Запуск на VPS з HTTPS (домен)

Для домену `watch.hotzagor.tech` використовуйте `docker-compose.vps.yml`, який:

- залишає `nginx` внутрішнім сервісом;
- піднімає `caddy` на `80/443`;
- автоматично випускає та оновлює TLS-сертифікат.
- не використовує `NGINX_PORT` (цей параметр лише для локального `docker-compose.yml`).

Команда запуску:

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

## Приклад `.env`

```env
PORT=4000
CLIENT_ORIGIN=http://localhost:5173,http://localhost:8080,https://watch.hotzagor.tech
ROOM_TTL_MINUTES=30
MP4_PROBE_ENABLED=true
MP4_PROBE_TIMEOUT_MS=8000
NGINX_PORT=8080
DOMAIN=watch.hotzagor.tech
```

## Деплой на VPS для `watch.hotzagor.tech`

1. DNS:
   - створіть `A`-запис `watch.hotzagor.tech` на публічну IP-адресу VPS.
2. Firewall:
   - відкрийте порти `80` і `443`;
   - порт `8080` назовні не відкривайте (він потрібен лише для локального варіанту).
3. На VPS:
   - скопіюйте проєкт;
   - створіть `.env` на базі `.env.example`;
   - перевірте, що `DOMAIN=watch.hotzagor.tech` і `CLIENT_ORIGIN` містить `https://watch.hotzagor.tech`.
4. Запуск:
   - `docker compose -f docker-compose.vps.yml up -d --build`
5. Перевірка:
   - відкрийте `https://watch.hotzagor.tech`.
   - сертифікат випускається автоматично (може зайняти 1-2 хв на першому старті).


## Як створити кімнату

1. Відкрити головну сторінку.
2. Вставити YouTube або прямий `.mp4` URL.
3. Натиснути “Створити кімнату”.
4. Передати друзям URL кімнати `/room/:roomId`.

## Як протестувати синхронізацію у 2 вкладках

1. Відкрийте одну і ту ж кімнату у двох вкладках браузера.
2. У вкладці №1 натисніть `Play`:
   - у вкладці №2 відео має почати відтворення з тієї ж секунди.
3. У вкладці №1 натисніть `Pause`:
   - у вкладці №2 відео має стати на паузу.
4. У вкладці №1 перемотайте відео:
   - у вкладці №2 відео має перейти на ту ж позицію.
5. Натисніть кнопку “Синхронізуватися з хостом” у вкладці №2:
   - стан має примусово підтягнутися з backend.

## Відомі обмеження MVP

- Кімнати зберігаються лише в пам’яті серверу:
  - після рестарту backend всі кімнати зникають.
- Немає авторизації/ролей:
  - керувати плеєром можуть всі учасники.
- Немає гарантії мілісекундної точності:
  - є невеликий дрейф мережі/браузера, який коригується auto-sync.
- Підтримуються тільки YouTube IFrame API та прямі `.mp4`.
- Частина “прямих” `.mp4` URL може відхилятися перевіркою, якщо джерело блокує `HEAD/Range` або вимагає авторизацію.
- Не реалізовано піратські джерела, парсинг сторонніх платформ і обхід DRM.

## Що можна додати далі

- Режим “керує тільки хост”.
- Авторизація та імена учасників.
- Персистентне зберігання кімнат у БД (Redis/PostgreSQL).
- Чат у кімнаті.
- Плейлист із кількох відео.
- Вимір та компенсація latency/ping на рівні клієнта.
- Інтеграційні тести Socket.IO сценаріїв.
