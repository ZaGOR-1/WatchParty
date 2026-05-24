import { io } from "socket.io-client";

let socket;

export function getSocket() {
  if (!socket) {
    const socketUrl = import.meta.env.VITE_SOCKET_URL || undefined;

      socket = io(socketUrl, {
      autoConnect: false,
      transports: ["websocket"],
      upgrade: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 10000,
      path: "/socket.io",
    });
  }

  return socket;
}
