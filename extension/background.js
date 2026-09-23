const SERVER_URL = "wss://browser-messenger.onrender.com";
const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_STORED_MESSAGES = 500;

let socket = null;
let activeRoomId = null;
let clientId = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let clientIdReady = null;

const messageState = {
  friendConnected: false,
  messages: [],
};

// Resolve the persistent client ID once, exactly once, so that calls to
// connect() never race with the asynchronous storage read.
function ensureClientId() {
  if (clientId) {
    return Promise.resolve(clientId);
  }

  if (!clientIdReady) {
    clientIdReady = new Promise((resolve) => {
      chrome.storage.local.get(["clientId"], (result) => {
        if (result.clientId) {
          clientId = result.clientId;
          resolve(clientId);
          return;
        }

        clientId = crypto.randomUUID();
        chrome.storage.local.set({ clientId }, () => resolve(clientId));
      });
    });
  }

  return clientIdReady;
}

function storageKey(roomId) {
  return `messages:${roomId}`;
}

function saveMessages() {
  if (!activeRoomId) {
    return;
  }

  chrome.storage.local.set({
    [storageKey(activeRoomId)]: messageState.messages,
  });
}

function loadMessages(roomId) {
  return new Promise((resolve) => {
    chrome.storage.local.get([storageKey(roomId)], (result) => {
      resolve(result[storageKey(roomId)] || []);
    });
  });
}

function withMine(message) {
  return { ...message, mine: message.senderId === clientId };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "connect") {
    connect(message.roomId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "disconnect") {
    disconnect();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "send") {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "Not connected." });
      return true;
    }

    socket.send(
      JSON.stringify({
        type: "message",
        messageType: message.messageType === "url" ? "url" : "text",
        text: message.text,
      }),
    );
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "markRead") {
    for (const messageId of message.messageIds || []) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "read", messageId }));
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "getState") {
    sendResponse({
      roomId: activeRoomId,
      status:
        socket && socket.readyState === WebSocket.OPEN
          ? "Connected"
          : "Disconnected",
      friendConnected: messageState.friendConnected,
      messages: messageState.messages.map(withMine),
    });
    return true;
  }

  return false;
});

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function connect(roomId) {
  await ensureClientId();

  const isSameRoom = activeRoomId === roomId;

  activeRoomId = roomId;
  messageState.friendConnected = false;

  // Restore persisted history only when switching rooms.
  if (!isSameRoom) {
    messageState.messages = await loadMessages(roomId);
  }

  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }

  socket = new WebSocket(SERVER_URL);

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "join",
        roomId: activeRoomId,
        clientId,
      }),
    );
    notifyPopup({ type: "status", status: "Connected" });

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  });

  socket.addEventListener("message", (event) => {
    let data;

    try {
      data = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (data.type === "joined") {
      messageState.friendConnected = data.users >= 2;
    } else if (data.type === "user-joined") {
      messageState.friendConnected = true;
    } else if (data.type === "user-left") {
      messageState.friendConnected = false;
    }

    if (data.type === "message" || data.type === "message-sent") {
      rememberMessage(data);
    }

    if (data.type === "message" && data.senderId !== clientId) {
      socket.send(
        JSON.stringify({
          type: "delivered",
          messageId: data.messageId,
        }),
      );
      showMessageNotification(data.text);
    }

    const payload = withMine(data);
    if (data.messageId) {
      payload.history = Boolean(data.history);
    }

    notifyPopup({ type: "serverMessage", data: payload });
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

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  activeRoomId = null;

  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }

  messageState.friendConnected = false;
  notifyPopup({ type: "status", status: "Disconnected" });
}

function rememberMessage(data) {
  if (
    !data.messageId ||
    messageState.messages.some(
      (message) => message.messageId === data.messageId,
    )
  ) {
    return;
  }

  messageState.messages.push({
    messageId: data.messageId,
    messageType: data.messageType || "text",
    text: data.text,
    senderId: data.senderId,
    createdAt: data.createdAt || Date.now(),
  });

  messageState.messages.sort(
    (left, right) => left.createdAt - right.createdAt,
  );

  while (messageState.messages.length > MAX_STORED_MESSAGES) {
    messageState.messages.shift();
  }

  saveMessages();
}

function scheduleReconnect() {
  if (!activeRoomId || reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(activeRoomId);
  }, RECONNECT_DELAY_MS);
}

chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  if (activeRoomId && (!socket || socket.readyState !== WebSocket.OPEN)) {
    connect(activeRoomId);
  }
});

async function connectSavedRoom() {
  await ensureClientId();

  const result = await new Promise((resolve) =>
    chrome.storage.local.get(["roomId"], resolve),
  );

  if (result.roomId && result.roomId !== activeRoomId) {
    connect(result.roomId);
  }
}

chrome.runtime.onStartup.addListener(connectSavedRoom);
chrome.runtime.onInstalled.addListener(connectSavedRoom);
connectSavedRoom();

function showMessageNotification(text) {
  chrome.notifications.create(`message-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/loaded.jpg",
    title: "Browser Messenger",
    message: text,
    priority: 1,
  });
}