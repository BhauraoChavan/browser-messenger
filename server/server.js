
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_ROOM_ID_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_SIZE = 500;

const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();

console.log(`WebSocket server running on port ${PORT}`);

// Send JSON data to a WebSocket client
function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// Get an existing room or create a new one
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      messages: new Map(),
    });
  }

  return rooms.get(roomId);
}

// Find a client by clientId
function getClient(room, clientId) {
  return [...room.clients].find(
    (client) => client.clientId === clientId
  );
}

// Send message delivery/read status to the sender
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

// Send data to everyone in the room except one socket
function notifyRoom(room, payload, exceptSocket) {
  for (const client of room.clients) {
    if (client !== exceptSocket) {
      send(client, payload);
    }
  }
}

// Remove a client from its room
function detachClient(socket, { broadcast = true } = {}) {
  const roomId = socket.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);

  room.clients.delete(socket);

  // Clear the socket's room information
  socket.roomId = null;

  if (broadcast) {
    notifyRoom(room, {
      type: "user-left",
    });
  }

  // Delete empty rooms when there are no clients
  // and no stored messages.
  if (room.clients.size === 0 && room.messages.size === 0) {
    rooms.delete(roomId);
  }
}

// Store a message and remove old messages
// when the history limit is exceeded.
function storeMessage(room, storedMessage) {
  room.messages.set(storedMessage.id, storedMessage);

  while (room.messages.size > MAX_HISTORY_SIZE) {
    const oldestMessageId = room.messages.keys().next().value;

    room.messages.delete(oldestMessageId);
  }
}

// Check allowed message types
function isValidMessageType(messageType) {
  return messageType === "text" || messageType === "url";
}

// WebSocket connection
wss.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      // -----------------------------
      // PING
      // -----------------------------
      if (message.type === "ping") {
        send(socket, {
          type: "pong",
        });

        return;
      }

      // -----------------------------
      // JOIN ROOM
      // -----------------------------
      if (message.type === "join") {
        const roomId = String(message.roomId || "").trim();
        const clientId = String(message.clientId || "").trim();

        if (
          !roomId ||
          roomId.length > MAX_ROOM_ID_LENGTH ||
          !clientId
        ) {
          send(socket, {
            type: "error",
            message: "Invalid room or client ID.",
          });

          return;
        }

        // Leave the previous room if the client
        // is joining a different room.
        if (socket.roomId && socket.roomId !== roomId) {
          detachClient(socket);
        }

        const room = getRoom(roomId);

        const existingClient = getClient(room, clientId);

        // If the same client reconnects,
        // remove the old socket without notifying
        // the other user that the client left.
        if (existingClient && existingClient !== socket) {
          detachClient(existingClient, {
            broadcast: false,
          });
        }

        // Maximum 2 users per room
        if (
          room.clients.size >= 10 &&
          !room.clients.has(socket)
        ) {
          send(socket, {
            type: "error",
            message: "Room is full. Maximum 2 users allowed.",
          });

          return;
        }

        // Attach socket to the room
        socket.roomId = roomId;
        socket.clientId = clientId;

        room.clients.add(socket);

        // Confirm successful join
        send(socket, {
          type: "joined",
          roomId,
          users: room.clients.size,
        });

        // Send previous message history
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

          // If this user was the sender,
          // send the current delivery/read status.
          if (storedMessage.senderId === clientId) {
            const recipientId = [
              ...storedMessage.recipientIds,
            ][0];

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

        // Notify the other user
        notifyRoom(
          room,
          {
            type: "user-joined",
          },
          socket
        );

        console.log(`User joined room: ${roomId}`);

        return;
      }

      // -----------------------------
      // MESSAGE
      // -----------------------------
      if (message.type === "message") {
        const room = rooms.get(socket.roomId);

        const text = String(message.text || "").trim();

        const messageType = isValidMessageType(
          message.messageType
        )
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

        // All other clients in the room are recipients
        const recipients = [...room.clients].filter(
          (client) => client !== socket
        );

        const storedMessage = {
          id: crypto.randomUUID(),

          senderId: socket.clientId,

          recipientIds: new Set(
            recipients.map(
              (client) => client.clientId
            )
          ),

          deliveredTo: new Set(),

          readBy: new Set(),

          messageType,

          text,

          createdAt: Date.now(),
        };

        // Store message
        storeMessage(room, storedMessage);

        // Confirm message to sender
        send(socket, {
          type: "message-sent",
          messageId: storedMessage.id,
          messageType: storedMessage.messageType,
          text: storedMessage.text,
          senderId: storedMessage.senderId,
          createdAt: storedMessage.createdAt,
        });

        // Send message to other users
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
          socket
        );

        return;
      }

      // -----------------------------
      // DELIVERED / READ
      // -----------------------------
      if (
        message.type === "delivered" ||
        message.type === "read"
      ) {
        const room = rooms.get(socket.roomId);

        const storedMessage =
          room?.messages.get(message.messageId);

        // Validate the message and make sure
        // the current user is actually a recipient.
        if (
          !room ||
          !storedMessage ||
          storedMessage.senderId === socket.clientId ||
          !storedMessage.recipientIds.has(socket.clientId)
        ) {
          return;
        }

        // READ status
        if (message.type === "read") {
          storedMessage.deliveredTo.add(
            socket.clientId
          );

          storedMessage.readBy.add(
            socket.clientId
          );

          broadcastStatus(
            room,
            storedMessage,
            "read",
            socket.clientId
          );
        }

        // DELIVERED status
        else {
          storedMessage.deliveredTo.add(
            socket.clientId
          );

          broadcastStatus(
            room,
            storedMessage,
            "delivered",
            socket.clientId
          );
        }

        return;
      }
    } catch (error) {
      console.error(
        "Invalid message:",
        error
      );

      send(socket, {
        type: "error",
        message: "Invalid message format.",
      });
    }
  });

  // -----------------------------
  // SOCKET CLOSED
  // -----------------------------
  socket.on("close", () => {
    console.log("Client disconnected");

    detachClient(socket);
  });

  // -----------------------------
  // SOCKET ERROR
  // -----------------------------
  socket.on("error", (error) => {
    console.error(
      "Socket error:",
      error.message
    );
  });
});

