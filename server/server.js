const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({
  port: PORT
});

const rooms = new Map();

console.log(`WebSocket server running on port ${PORT}`);

wss.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Join room
      if (message.type === "join") {
        const roomId = message.roomId;

        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
        }

        const room = rooms.get(roomId);

        if (room.size >= 2) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Room is full. Maximum 2 users allowed."
            })
          );
          return;
        }

        room.add(socket);
        socket.roomId = roomId;

        socket.send(
          JSON.stringify({
            type: "joined",
            roomId,
            users: room.size
          })
        );

        // Tell the other user
        room.forEach((client) => {
          if (client !== socket && client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "user-joined"
              })
            );
          }
        });

        console.log(`User joined room: ${roomId}`);
        return;
      }

      // Message inside room
      if (message.type === "message") {
        const roomId = socket.roomId;

        if (!roomId || !rooms.has(roomId)) {
          return;
        }

        const room = rooms.get(roomId);

        room.forEach((client) => {
          if (
            client !== socket &&
            client.readyState === WebSocket.OPEN
          ) {
            client.send(
              JSON.stringify(message)
            );
          }
        });
      }
    } catch (error) {
      console.error("Invalid message:", error);
    }
  });

  socket.on("close", () => {
    const roomId = socket.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);

    room.delete(socket);

    room.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "user-left"
          })
        );
      }
    });

    if (room.size === 0) {
      rooms.delete(roomId);
    }

    console.log("Client disconnected");
  });
});