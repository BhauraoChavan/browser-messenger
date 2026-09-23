
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const MAX_ROOM_ID_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_SIZE = 500;
const MAX_ROOM_USERS = 10;

const wss = new WebSocket.Server({
  port: PORT,
});

const rooms = new Map();

console.log(`WebSocket server running on port ${PORT}`);


// ========================================
// SEND JSON TO CLIENT
// ========================================

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}


// ========================================
// GET OR CREATE ROOM
// ========================================

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      messages: new Map(),
    });
  }

  return rooms.get(roomId);
}


// ========================================
// GET CLIENT BY ID
// ========================================

function getClient(room, clientId) {
  return [...room.clients].find(
    (client) => client.clientId === clientId
  );
}


// ========================================
// SEND MESSAGE STATUS TO SENDER
// ========================================

function broadcastStatus(
  room,
  message,
  status,
  clientId
) {
  const sender = getClient(
    room,
    message.senderId
  );

  if (sender) {
    send(sender, {
      type: "message-status",
      messageId: message.id,
      status,
      clientId,
    });
  }
}


// ========================================
// BROADCAST TO ROOM
// ========================================

function notifyRoom(
  room,
  payload,
  exceptSocket = null
) {
  for (const client of room.clients) {
    if (client !== exceptSocket) {
      send(client, payload);
    }
  }
}


// ========================================
// REMOVE CLIENT FROM ROOM
// ========================================

function detachClient(
  socket,
  { broadcast = true } = {}
) {
  const roomId = socket.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);

  room.clients.delete(socket);

  socket.roomId = null;

  if (broadcast) {
    notifyRoom(room, {
      type: "user-left",
      clientId: socket.clientId,
    });
  }

  // Delete empty room if there are no messages.
  if (
    room.clients.size === 0 &&
    room.messages.size === 0
  ) {
    rooms.delete(roomId);
  }
}


// ========================================
// STORE MESSAGE
// ========================================

function storeMessage(room, message) {
  room.messages.set(message.id, message);

  while (
    room.messages.size > MAX_HISTORY_SIZE
  ) {
    const oldestMessageId =
      room.messages.keys().next().value;

    room.messages.delete(oldestMessageId);
  }
}


// ========================================
// VALID MESSAGE TYPE
// ========================================

function isValidMessageType(type) {
  return (
    type === "text" ||
    type === "url"
  );
}


// ========================================
// NEW CONNECTION
// ========================================

wss.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(
        data.toString()
      );


      // ====================================
      // PING
      // ====================================

      if (message.type === "ping") {
        send(socket, {
          type: "pong",
        });

        return;
      }


      // ====================================
      // JOIN ROOM
      // ====================================

      if (message.type === "join") {
        const roomId = String(
          message.roomId || ""
        ).trim();

        const clientId = String(
          message.clientId || ""
        ).trim();

        if (
          !roomId ||
          roomId.length >
            MAX_ROOM_ID_LENGTH ||
          !clientId
        ) {
          send(socket, {
            type: "error",
            message:
              "Invalid room or client ID.",
          });

          return;
        }


        // Leave previous room
        if (
          socket.roomId &&
          socket.roomId !== roomId
        ) {
          detachClient(socket);
        }


        const room = getRoom(roomId);

        const existingClient =
          getClient(
            room,
            clientId
          );


        // Reconnecting client
        if (
          existingClient &&
          existingClient !== socket
        ) {
          detachClient(
            existingClient,
            {
              broadcast: false,
            }
          );
        }


        // Room limit
        if (
          room.clients.size >=
            MAX_ROOM_USERS &&
          !room.clients.has(socket)
        ) {
          send(socket, {
            type: "error",
            message:
              `Room is full. Maximum ${MAX_ROOM_USERS} users allowed.`,
          });

          return;
        }


        // Add client
        socket.roomId = roomId;
        socket.clientId = clientId;

        room.clients.add(socket);


        // Confirm join
        send(socket, {
          type: "joined",
          roomId,
          users: room.clients.size,
          maxUsers: MAX_ROOM_USERS,
        });


        // Send message history
        for (
          const storedMessage of
          room.messages.values()
        ) {
          send(socket, {
            type: "message",
            messageId:
              storedMessage.id,
            messageType:
              storedMessage.messageType,
            text:
              storedMessage.text,
            senderId:
              storedMessage.senderId,
            createdAt:
              storedMessage.createdAt,
            history: true,
          });


          // Send sender's message status
          if (
            storedMessage.senderId ===
            clientId
          ) {
            const recipientId = [
              ...storedMessage.recipientIds,
            ][0];

            let status = "sent";

            if (recipientId) {
              if (
                storedMessage.readBy.has(
                  recipientId
                )
              ) {
                status = "read";
              } else if (
                storedMessage.deliveredTo.has(
                  recipientId
                )
              ) {
                status = "delivered";
              }
            }

            send(socket, {
              type:
                "message-status",
              messageId:
                storedMessage.id,
              status,
            });
          }
        }


        // Notify other users
        notifyRoom(
          room,
          {
            type: "user-joined",
            clientId,
            users:
              room.clients.size,
          },
          socket
        );

        console.log(
          `User ${clientId} joined room ${roomId}`
        );

        return;
      }


      // ====================================
      // CHAT MESSAGE
      // ====================================

      if (
        message.type === "message"
      ) {
        const room =
          rooms.get(socket.roomId);

        const text = String(
          message.text || ""
        ).trim();

        const messageType =
          isValidMessageType(
            message.messageType
          )
            ? message.messageType
            : "text";


        // Validate
        if (
          !room ||
          !socket.clientId ||
          !text ||
          text.length >
            MAX_MESSAGE_LENGTH
        ) {
          send(socket, {
            type: "error",
            message:
              "Message is empty or too long.",
          });

          return;
        }


        // Other users
        const recipients = [
          ...room.clients,
        ].filter(
          (client) =>
            client !== socket
        );


        const storedMessage = {
          id: crypto.randomUUID(),

          senderId:
            socket.clientId,

          recipientIds:
            new Set(
              recipients.map(
                (client) =>
                  client.clientId
              )
            ),

          deliveredTo:
            new Set(),

          readBy:
            new Set(),

          messageType,

          text,

          createdAt: Date.now(),
        };


        // Save message
        storeMessage(
          room,
          storedMessage
        );


        // Confirm to sender
        send(socket, {
          type: "message-sent",

          messageId:
            storedMessage.id,

          messageType:
            storedMessage.messageType,

          text:
            storedMessage.text,

          senderId:
            storedMessage.senderId,

          createdAt:
            storedMessage.createdAt,
        });


        // Send to other users
        notifyRoom(
          room,
          {
            type: "message",

            messageId:
              storedMessage.id,

            messageType:
              storedMessage.messageType,

            text:
              storedMessage.text,

            senderId:
              storedMessage.senderId,

            createdAt:
              storedMessage.createdAt,
          },
          socket
        );

        return;
      }


      // ====================================
      // DELIVERED / READ
      // ====================================

      if (
        message.type === "delivered" ||
        message.type === "read"
      ) {
        const room =
          rooms.get(socket.roomId);

        const storedMessage =
          room?.messages.get(
            message.messageId
          );


        // Security validation
        if (
          !room ||
          !storedMessage ||
          storedMessage.senderId ===
            socket.clientId ||
          !storedMessage.recipientIds.has(
            socket.clientId
          )
        ) {
          return;
        }


        // READ
        if (
          message.type === "read"
        ) {
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


        // DELIVERED
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
        message:
          "Invalid message format.",
      });
    }
  });


  // ========================================
  // CONNECTION CLOSED
  // ========================================

  socket.on("close", () => {
    console.log(
      `Client disconnected: ${
        socket.clientId || "unknown"
      }`
    );

    detachClient(socket);
  });


  // ========================================
  // SOCKET ERROR
  // ========================================

  socket.on("error", (error) => {
    console.error(
      "Socket error:",
      error.message
    );
  });
});



let socket = null;

const WS_URL = "ws://localhost:8080";

const roomId =
  new URLSearchParams(
    window.location.search
  ).get("room") || "general";

let clientId =
  localStorage.getItem("clientId");

if (!clientId) {
  clientId = crypto.randomUUID();

  localStorage.setItem(
    "clientId",
    clientId
  );
}

let reconnectTimer = null;
let manuallyClosed = false;


// ========================================
// CONNECT WEBSOCKET
// ========================================

function connectWebSocket() {
  if (
    socket &&
    (
      socket.readyState ===
        WebSocket.OPEN ||
      socket.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  console.log(
    "Connecting to WebSocket..."
  );

  socket = new WebSocket(
    WS_URL
  );


  // ======================================
  // OPEN
  // ======================================

  socket.onopen = () => {
    console.log(
      "WebSocket connected"
    );

    if (reconnectTimer) {
      clearTimeout(
        reconnectTimer
      );

      reconnectTimer = null;
    }


    // Join room
    socket.send(
      JSON.stringify({
        type: "join",

        roomId,

        clientId,
      })
    );
  };


  // ======================================
  // MESSAGE
  // ======================================

  socket.onmessage = (event) => {
    try {
      const data =
        JSON.parse(
          event.data
        );

      console.log(
        "Server:",
        data
      );


      // -------------------------------
      // JOINED
      // -------------------------------

      if (
        data.type === "joined"
      ) {
        console.log(
          `Joined room: ${data.roomId}`
        );

        console.log(
          `Users: ${data.users}/${data.maxUsers}`
        );

        return;
      }


      // -------------------------------
      // NEW MESSAGE
      // -------------------------------

      if (
        data.type === "message"
      ) {
        console.log(
          "Message:",
          data.text
        );


        // Automatically mark received
        // message as delivered.
        sendDelivered(
          data.messageId
        );


        // Mark as read
        sendRead(
          data.messageId
        );


        // TODO:
        // Add message to your chat UI.

        return;
      }


      // -------------------------------
      // MESSAGE SENT
      // -------------------------------

      if (
        data.type ===
        "message-sent"
      ) {
        console.log(
          "Message sent:",
          data.messageId
        );

        return;
      }


      // -------------------------------
      // MESSAGE STATUS
      // -------------------------------

      if (
        data.type ===
        "message-status"
      ) {
        console.log(
          "Message status:",
          data.status
        );

        return;
      }


      // -------------------------------
      // USER JOINED
      // -------------------------------

      if (
        data.type ===
        "user-joined"
      ) {
        console.log(
          "User joined:",
          data.clientId
        );

        return;
      }


      // -------------------------------
      // USER LEFT
      // -------------------------------

      if (
        data.type ===
        "user-left"
      ) {
        console.log(
          "User left:",
          data.clientId
        );

        return;
      }


      // -------------------------------
      // PONG
      // -------------------------------

      if (
        data.type === "pong"
      ) {
        console.log(
          "Pong received"
        );

        return;
      }


      // -------------------------------
      // ERROR
      // -------------------------------

      if (
        data.type === "error"
      ) {
        console.error(
          "Server error:",
          data.message
        );

        return;
      }

    } catch (error) {
      console.error(
        "Invalid server response:",
        error
      );
    }
  };


  // ======================================
  // CLOSE
  // ======================================

  socket.onclose = () => {
    console.log(
      "WebSocket disconnected"
    );

    socket = null;


    if (
      manuallyClosed
    ) {
      return;
    }


    // IMPORTANT:
    // Do NOT use:
    //
    // location.reload();
    //
    // We reconnect only the WebSocket.

    if (!reconnectTimer) {
      reconnectTimer =
        setTimeout(() => {
          reconnectTimer =
            null;

          connectWebSocket();

        }, 2000);
    }
  };


  // ======================================
  // ERROR
  // ======================================

  socket.onerror = (error) => {
    console.error(
      "WebSocket error:",
      error
    );
  };
}


// ========================================
// SEND MESSAGE
// ========================================

function sendMessage(text) {
  text = String(
    text || ""
  ).trim();


  if (!text) {
    return;
  }


  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    console.log(
      "WebSocket is not connected"
    );

    return;
  }


  socket.send(
    JSON.stringify({
      type: "message",

      messageType: "text",

      text,
    })
  );
}


// ========================================
// SEND DELIVERED
// ========================================

function sendDelivered(
  messageId
) {
  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }


  socket.send(
    JSON.stringify({
      type: "delivered",

      messageId,
    })
  );
}


// ========================================
// SEND READ
// ========================================

function sendRead(
  messageId
) {
  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }


  socket.send(
    JSON.stringify({
      type: "read",

      messageId,
    })
  );
}


// ========================================
// PING
// ========================================

function pingServer() {
  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify({
        type: "ping",
      })
    );
  }
}


// Ping every 30 seconds
setInterval(
  pingServer,
  30000
);


// ========================================
// CHAT FORM
// ========================================

const chatForm =
  document.getElementById(
    "chatForm"
  );

const messageInput =
  document.getElementById(
    "messageInput"
  );


if (chatForm) {
  chatForm.addEventListener(
    "submit",
    (event) => {

      // VERY IMPORTANT:
      // Prevent browser auto-refresh.
      event.preventDefault();

      sendMessage(
        messageInput?.value
      );

      if (messageInput) {
        messageInput.value = "";

        messageInput.focus();
      }
    }
  );
}


// ========================================
// START
// ========================================

connectWebSocket();


// ========================================
// OPTIONAL MANUAL DISCONNECT
// ========================================

function disconnectWebSocket() {
  manuallyClosed = true;

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;
  }

  if (socket) {
    socket.close();
  }
}

