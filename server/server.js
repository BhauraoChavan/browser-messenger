const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_ROOM_ID_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_SIZE = 500;

const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();

console.log(`WebSocket server running on port ${PORT}`);

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      messages: new Map(),
    });
  }

  return rooms.get(roomId);
}

function getClient(room, clientId) {
  return [...room.clients].find((client) => client.clientId === clientId);
}

function broadcastStatus(room, message, status, clientId) {
  const sender = getClient(room, message.senderId);

  if (sender) {
    send(sender, {
      type: "message-status",
      messageId: message.id,
      status,
      clientId,
    });
  }
}

function notifyRoom(room, payload, exceptSocket) {
  for (const client of room.clients) {
    if (client !== exceptSocket) {
      send(client, payload);
    }
  }
}

function detachClient(socket, { broadcast = true } = {}) {
  const roomId = socket.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  room.clients.delete(socket);

  if (broadcast) {
    notifyRoom(room, { type: "user-left" });
  }

  // Free memory once nobody is left in the room.
  if (room.clients.size === 0 && room.messages.size === 0) {
    rooms.delete(roomId);
  }
}

function storeMessage(room, storedMessage) {
  room.messages.set(storedMessage.id, storedMessage);

  while (room.messages.size > MAX_HISTORY_SIZE) {
    const oldestMessageId = room.messages.keys().next().value;
    room.messages.delete(oldestMessageId);
  }
}

function isValidMessageType(messageType) {
  return messageType === "text" || messageType === "url";
}

wss.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "ping") {
        return;
      }

      if (message.type === "join") {
        const roomId = String(message.roomId || "").trim();
        const clientId = String(message.clientId || "").trim();

        if (!roomId || roomId.length > MAX_ROOM_ID_LENGTH || !clientId) {
          send(socket, {
            type: "error",
            message: "Invalid room or client ID.",
          });
          return;
        }

        // Leave the previous room (if any) before joining a new one.
        if (socket.roomId && socket.roomId !== roomId) {
          detachClient(socket);
        }

        const room = getRoom(roomId);
        const existingClient = getClient(room, clientId);

        // A reconnecting client replaces its stale socket without telling the
        // other user that the peer left (which would be a false "offline").
        if (existingClient && existingClient !== socket) {
          existingClient.roomId = null;
          detachClient(existingClient, { broadcast: false });
        }

        if (room.clients.size >= 2 && !room.clients.has(socket)) {
          send(socket, {
            type: "error",
            message: "Room is full. Maximum 2 users allowed.",
          });
          return;
        }

        socket.roomId = roomId;
        socket.clientId = clientId;
        room.clients.add(socket);

        send(socket, {
          type: "joined",
          roomId,
          users: room.clients.size,
        });

        for (const storedMessage of room.messages.values()) {
          send(socket, {
            type: "message",
            messageId: storedMessage.id,
            messageType: storedMessage.messageType,
            text: storedMessage.text,
            senderId: storedMessage.senderId,
            createdAt: storedMessage.createdAt,
            history: true,
          });

          if (storedMessage.senderId === clientId) {
            const recipientId = [...storedMessage.recipientIds][0];
            const status = recipientId
              ? storedMessage.readBy.has(recipientId)
                ? "read"
                : storedMessage.deliveredTo.has(recipientId)
                  ? "delivered"
                  : "sent"
              : "sent";

            send(socket, {
              type: "message-status",
              messageId: storedMessage.id,
              status,
            });
          }
        }

        notifyRoom(room, { type: "user-joined" }, socket);

        console.log(`User joined room: ${roomId}`);
        return;
      }

      if (message.type === "message") {
        const room = rooms.get(socket.roomId);
        const text = String(message.text || "").trim();
        const messageType = isValidMessageType(message.messageType)
          ? message.messageType
          : "text";

        if (
          !room ||
          !socket.clientId ||
          !text ||
          text.length > MAX_MESSAGE_LENGTH
        ) {
          send(socket, {
            type: "error",
            message: "Message is empty or too long.",
          });
          return;
        }

        const recipients = [...room.clients].filter(
          (client) => client !== socket,
        );

        const storedMessage = {
          id: crypto.randomUUID(),
          senderId: socket.clientId,
          recipientIds: new Set(recipients.map((client) => client.clientId)),
          deliveredTo: new Set(),
          readBy: new Set(),
          messageType,
          text,
          createdAt: Date.now(),
        };

        storeMessage(room, storedMessage);

        send(socket, {
          type: "message-sent",
          messageId: storedMessage.id,
          messageType: storedMessage.messageType,
          text: storedMessage.text,
          senderId: storedMessage.senderId,
          createdAt: storedMessage.createdAt,
        });

        notifyRoom(
          room,
          {
            type: "message",
            messageId: storedMessage.id,
            messageType: storedMessage.messageType,
            text: storedMessage.text,
            senderId: storedMessage.senderId,
            createdAt: storedMessage.createdAt,
          },
          socket,
        );
        return;
      }

      if (message.type === "delivered" || message.type === "read") {
        const room = rooms.get(socket.roomId);
        const storedMessage = room?.messages.get(message.messageId);

        if (
          !room ||
          !storedMessage ||
          storedMessage.senderId === socket.clientId
        ) {
          return;
        }

        if (message.type === "read") {
          storedMessage.deliveredTo.add(socket.clientId);
          storedMessage.readBy.add(socket.clientId);
          broadcastStatus(room, storedMessage, "read", socket.clientId);
        } else {
          storedMessage.deliveredTo.add(socket.clientId);
          broadcastStatus(room, storedMessage, "delivered", socket.clientId);
        }
      }
    } catch (error) {
      console.error("Invalid message:", error);
      send(socket, {
        type: "error",
        message: "Invalid message format.",
      });
    }
  });

  socket.on("close", () => {
    detachClient(socket);
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });
});