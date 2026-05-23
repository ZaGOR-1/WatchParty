# Zagor Watch Party (MVP)

MVP вебсервісу для синхронного перегляду одного або кількох відео кількома людьми в кімнаті.
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
  - `addToPlaylist`
  - `removeFromPlaylist`
  - `setCurrentPlaylistItem`
  - `videoEnded`
  - `playlistUpdated`
  - `playlistAdvanced`
  - `syncRequest`
  - `syncResponse`
  - `timeSync` (оцінка offset клієнтського годинника відносно сервера)
  - `userJoined`
  - `userLeft`
- Показ:
  - посилання на кімнату + кнопка копіювання
  - список підключених учасників з нікнеймами
  - стан з’єднання Socket.IO
- Автовідновлення після обриву мережі:
  - автоматичний reconnect Socket.IO
  - повторний `joinRoom` після підключення
  - контрольний `syncRequest` після reconnection для вирівнювання стану плеєра
- Авто-синхронізація кожні ~7 секунд для корекції дрейфу.
- Корекція дрейфу:
  - `hard correction` при великому розходженні позиції
  - `soft correction` при помірному дрейфі під час відтворення
  - cooldown між м’якими корекціями, щоб не було "смикань" плеєра
- Періодичний перерахунок `server time offset` для стабільнішого `play/seek` на повільному інтернеті.
- Ручна кнопка “Синхронізуватися з хостом”.
- Плейлист у кімнаті:
  - додавання кількох відео
  - перемикання між відео
  - автоперехід на наступне після завершення поточного
- Очищення порожніх кімнат через TTL.
- Базовий monitoring:
  - інтеграція з Sentry для помилок backend/socket
  - `/api/metrics` з метриками `socket errors`, `disconnect rate`, `room lifetime`

## Технологічний стек

- Frontend: React + Vite (JavaScript)
- Backend: Node.js + Express
- Realtime: Socket.IO
- Reverse proxy: Nginx
- TLS/публічний вхід (VPS): Caddy
- Контейнеризація: Docker + Docker Compose
- Зберігання стану: Redis (персистентно, AOF у Docker)

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
- `playlist` (масив відео у черзі)
- `currentIndex` (поточний елемент плейлиста)
- `currentItem` (поточне відео)
- `isPlaying`
- `currentTime`
- `stateCurrentTime` (базова позиція в момент останнього оновлення стану)
- `updatedAt`
- `stateUpdatedAt` (timestamp останнього оновлення playback-стану на сервері)
- `serverNowMs` (server timestamp під час формування snapshot)
- `usersCount`
- `participants` (`socketId`, `nickname`, `joinedAt`)

Якщо `isPlaying = true`, актуальний час при читанні стану оцінюється як:

`stateCurrentTime + (serverNowMs - stateUpdatedAt) / 1000`

На frontend ця формула рахується з поправкою на clock offset, що вимірюється через `timeSync`.

## Персистентність кімнат (Redis)

- Стан кімнати та учасники тепер зберігаються у Redis, а не в RAM процесу Node.js.
- Після рестарту backend-контейнера/процесу кімнати не зникають, поки не спрацює TTL або ручне очищення.
- У Docker Compose Redis запускається як окремий сервіс `redis` з AOF (`appendonly yes`) і volume `redis_data`.
- Backend використовує:
  - `REDIS_URL` (наприклад `redis://redis:6379` у Docker)
  - `REDIS_KEY_PREFIX` (ізоляція ключів проєкту)

## HTTP API

### `POST /api/rooms`

Body:

```json
{
  "videoUrls": [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://filesamples.com/samples/video/mp4/sample_640x360.mp4"
  ]
}
```

Також підтримується старий формат з одним полем `videoUrl`.

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
  "playlist": [
    {
      "itemId": "b3d4f60f-7e85-4ff7-9f23-2af0f7a3c8de",
      "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "videoType": "youtube",
      "videoId": "dQw4w9WgXcQ",
      "addedAt": 1710000000100,
      "addedBy": "Zagor"
    }
  ],
  "currentIndex": 0,
  "currentItem": {
    "itemId": "b3d4f60f-7e85-4ff7-9f23-2af0f7a3c8de",
    "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "videoType": "youtube",
    "videoId": "dQw4w9WgXcQ",
    "addedAt": 1710000000100,
    "addedBy": "Zagor"
  },
  "isPlaying": false,
  "currentTime": 0,
  "stateCurrentTime": 0,
  "updatedAt": 1710000000000,
  "stateUpdatedAt": 1710000000000,
  "serverNowMs": 1710000001234,
  "usersCount": 2,
  "participants": [
    {
      "socketId": "Pj8xY3P9Dnz2X4dAAAAB",
      "nickname": "Zagor",
      "joinedAt": 1710000000500
    }
  ]
}
```

### `GET /api/metrics`

Повертає JSON зі службовими метриками backend:

- socket:
  - `connectionsTotal`
  - `disconnectsTotal`
  - `errorsTotal`
  - `handlerErrorsByEvent`
  - `disconnectReasons`
  - `rollingWindow.disconnectRatio` / `disconnectPercent` / `disconnectsPerMinute`
- rooms:
  - `createdTotal`
  - `removedTotal`
  - `removedByReason`
  - `lifetimeSec` (`avg`, `min`, `max`, `last`)

Якщо задано `METRICS_TOKEN`, endpoint вимагає один із варіантів авторизації:

- заголовок `x-metrics-token: <token>`
- заголовок `Authorization: Bearer <token>`

## Стабільність синхронізації

- При підключенні та періодично клієнт виконує `timeSync` з ack-відповіддю:
  - клієнт відправляє `clientSentAt`
  - сервер повертає `serverNowMs`
  - клієнт рахує RTT і offset за midpoint-методом
- З кількох вимірів беруться найкращі (з найменшим RTT), після чого формується зважений offset.
- Під час `play/pause/seek/roomState/syncResponse` клієнт:
  - оцінює очікуваний server-time для позиції відео
  - порівнює з локальною позицією
  - застосовує `hard` або `soft` корекцію залежно від drift.

## Моніторинг і логування

- Sentry:
  - увімкніть, задавши `SENTRY_DSN` у `.env`
  - backend відправляє в Sentry:
    - server-side помилки HTTP/Socket
    - `uncaughtException`
    - `unhandledRejection`
  - перед shutdown backend робить `flush` подій, щоб не втрачати останні помилки
- Локальні метрики (in-memory):
  - збираються у rolling-window (`METRICS_WINDOW_MS`, за замовчуванням 5 хв)
  - метрики доступні через `GET /api/metrics`

## Запуск локально без Docker

### 1) Підготовка

1. Скопіюйте `.env.example` у `.env`.
2. Встановіть Node.js 20+.
3. Встановіть і запустіть Redis локально (або підніміть Redis окремо у Docker).

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
- Redis має бути доступний за `REDIS_URL` (за замовчуванням `redis://127.0.0.1:6379`)
- якщо Redis недоступний, backend не стартує (це очікувана поведінка для гарантії персистентності).

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
- Redis піднімається автоматично як сервіс `redis` (дані в volume `redis_data`).

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
PLAYLIST_MAX_ITEMS=50
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=watchparty
MP4_PROBE_ENABLED=true
MP4_PROBE_TIMEOUT_MS=8000
METRICS_WINDOW_MS=300000
METRICS_TOKEN=
SENTRY_DSN=
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=watch-party-server@local
SENTRY_TRACES_SAMPLE_RATE=0
SENTRY_DEBUG=false
NGINX_PORT=8080
DOMAIN=watch.hotzagor.tech
```

> У Docker Compose для backend автоматично використовується `redis://redis:6379` (service-name Redis у внутрішній мережі).

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
2. Ввести свій нікнейм.
3. Вставити одне або кілька YouTube / `.mp4` URL (кожен з нового рядка).
4. Натиснути “Створити кімнату”.
5. Передати друзям URL кімнати `/room/:roomId`.

## Як протестувати плейлист і автоперехід

1. Створіть кімнату з 2+ відео.
2. У кімнаті перевірте, що блок “Плейлист кімнати” показує чергу.
3. Дочекайтеся завершення поточного відео:
   - має відбутися автоперехід на наступне.
4. Натисніть на інше відео в плейлисті:
   - у всіх учасників має переключитися поточний трек.
5. Додайте нове посилання через форму “Додати відео в чергу”:
   - новий елемент має з’явитися у всіх учасників.
6. Видаліть елемент плейлиста:
   - список має оновитися синхронно в усіх вкладках.

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
6. Перевірте reconnect:
   - у вкладці №2 тимчасово вимкніть мережу (або перезапустіть backend), потім увімкніть назад.
   - вкладка має перейти в стан “Відновлення...”, автоматично перепідключитись і вирівняти позицію плеєра через `syncRequest`.

## Відомі обмеження MVP

- Немає авторизації/ролей:
  - керувати плеєром можуть всі учасники.
- Нікнейми не унікальні:
  - різні учасники можуть вибрати однакове ім’я.
- Один Redis-інстанс без кластеризації:
  - для high-availability потрібні Sentinel/Cluster і реплікація.
- Один backend-процес Socket.IO:
  - для горизонтального масштабування потрібен `@socket.io/redis-adapter`.
- Метрики з `/api/metrics` зберігаються лише в RAM процесу:
  - після рестарту backend-метрики обнуляються.
- Автоплей наступного відео може блокуватися політиками браузера:
  - якщо вкладка неактивна або користувач не взаємодіяв із плеєром.
- Немає гарантії мілісекундної точності:
  - є невеликий дрейф мережі/браузера, який коригується auto-sync.
- Підтримуються тільки YouTube IFrame API та прямі `.mp4`.
- Частина “прямих” `.mp4` URL може відхилятися перевіркою, якщо джерело блокує `HEAD/Range` або вимагає авторизацію.
- Не реалізовано піратські джерела, парсинг сторонніх платформ і обхід DRM.

## Що можна додати далі

- Режим “керує тільки хост”.
- Авторизація та імена учасників.
- Історія кімнат і аналітика в PostgreSQL (поверх Redis як realtime-store).
- Чат у кімнаті.
- Drag-and-drop сортування плейлиста.
- Вимір та компенсація latency/ping на рівні клієнта.
- Інтеграційні тести Socket.IO сценаріїв.
