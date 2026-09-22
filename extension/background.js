const SERVER_URL = "wss://browser-messenger.onrender.com";

let socket = null;
let activeRoomId = null;
let reconnectTimer = null;
let heartbeatTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "connect") {
    connect(message.roomId);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "send") {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "Not connected." });
      return;
    }

    socket.send(JSON.stringify({
      type: "message",
      messageType: "text",
      text: message.text,
    }));
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "getState") {
    sendResponse({
      status: socket && socket.readyState === WebSocket.OPEN
        ? "Connected"
        : "Disconnected",
      friendConnected: Boolean(messageState.friendConnected),
    });
  }
});

const messageState = {
  friendConnected: false,
};

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function connect(roomId) {
  activeRoomId = roomId;
  messageState.friendConnected = false;

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }

  socket = new WebSocket(SERVER_URL);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", roomId: activeRoomId }));
    notifyPopup({ type: "status", status: "Connected" });

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "joined") {
      messageState.friendConnected = data.users >= 2;
    } else if (data.type === "user-joined") {
      messageState.friendConnected = true;
    } else if (data.type === "user-left") {
      messageState.friendConnected = false;
    }

    notifyPopup({ type: "serverMessage", data });
  });

  socket.addEventListener("close", () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    messageState.friendConnected = false;
    notifyPopup({ type: "status", status: "Disconnected" });
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    notifyPopup({ type: "status", status: "Connection error" });
  });
}

function scheduleReconnect() {
  if (!activeRoomId || reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(activeRoomId);
  }, 5000);
}

chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  if (activeRoomId && (!socket || socket.readyState !== WebSocket.OPEN)) {
    connect(activeRoomId);
  }
});

chrome.storage.local.get(["roomId"], (result) => {
  if (result.roomId) {
    activeRoomId = result.roomId;
    connect(activeRoomId);
  }
});
