const roomInput = document.getElementById("roomInput");
const connectBtn = document.getElementById("connectBtn");
const statusElement = document.getElementById("status");
const connectionLogo = document.getElementById("connectionLogo");
const chatSection = document.getElementById("chatSection");
const messagesElement = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

let friendConnected = false;

function setMessagingEnabled(enabled) {
  friendConnected = enabled;
  messageInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

function applyStatus(status) {
  statusElement.textContent = status;
  connectionLogo.src = status === "Connected"
    ? "icons/loaded.jpg"
    : "icons/preload.jpg";

  if (status !== "Connected") {
    setMessagingEnabled(false);
  }
}

chrome.storage.local.get(["roomId"], (result) => {
  if (result.roomId) {
    roomInput.value = result.roomId;
  }
});

chrome.runtime.sendMessage({ type: "getState" }, (state) => {
  if (chrome.runtime.lastError || !state) {
    return;
  }

  applyStatus(state.status);
  setMessagingEnabled(state.friendConnected);
  if (state.status === "Connected") {
    chatSection.classList.remove("hidden");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status") {
    applyStatus(message.status);
    return;
  }

  if (message.type === "serverMessage") {
    handleMessage(message.data);
  }
});

connectBtn.addEventListener("click", () => {
  const roomId = roomInput.value.trim();

  if (!roomId) {
    alert("Please enter a Room ID.");
    return;
  }

  chrome.storage.local.set({ roomId });
  applyStatus("Connecting...");
  setMessagingEnabled(false);
  chrome.runtime.sendMessage({ type: "connect", roomId });
});

sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendMessage();
  }
});

function handleMessage(data) {
  if (data.type === "joined") {
    chatSection.classList.remove("hidden");
    setMessagingEnabled(data.users >= 2);
    addSystemMessage(`Joined room: ${data.roomId}`);

    if (data.users === 1) {
      addSystemMessage("Waiting for your friend...");
    }
    return;
  }

  if (data.type === "user-joined") {
    setMessagingEnabled(true);
    addSystemMessage("Your friend joined the room 🟢");
    return;
  }

  if (data.type === "user-left") {
    setMessagingEnabled(false);
    addSystemMessage("Your friend left the room 🔴");
    return;
  }

  if (data.type === "message") {
    addFriendMessage(data.text);
    return;
  }

  if (data.type === "error") {
    alert(data.message);
  }
}

function sendMessage() {
  const text = messageInput.value.trim();

  if (!text) {
    return;
  }

  if (!friendConnected) {
    addSystemMessage("Waiting for your friend to join...");
    return;
  }

  chrome.runtime.sendMessage({ type: "send", text }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      alert(response?.error || "Not connected.");
      return;
    }

    addMyMessage(text);
    messageInput.value = "";
  });
}

function addMyMessage(text) {
  addMessage(`You: ${text}`, "mine");
}

function addFriendMessage(text) {
  addMessage(`Friend: ${text}`, "friend");
}

function addSystemMessage(text) {
  addMessage(text, "system");
}

function addMessage(text, className) {
  const div = document.createElement("div");
  div.className = `message ${className}`;
  div.textContent = text;
  messagesElement.appendChild(div);
  messagesElement.scrollTop = messagesElement.scrollHeight;
}
