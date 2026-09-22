let socket = null;

let roomId = null;


// Change this when you deploy your server
 const SERVER_URL = "wss://browser-messenger.onrender.com";


const roomInput = document.getElementById("roomInput");
const connectBtn = document.getElementById("connectBtn");

const statusElement = document.getElementById("status");

const chatSection = document.getElementById("chatSection");

const messagesElement = document.getElementById("messages");

const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

const urlBtn = document.getElementById("urlBtn");


// Connect to server
connectBtn.addEventListener("click", connect);


// Connect function
function connect() {

  roomId = roomInput.value.trim();

  if (!roomId) {
    alert("Please enter a Room ID.");
    return;
  }

  statusElement.textContent = "Connecting...";

  socket = new WebSocket(SERVER_URL);


  socket.addEventListener("open", () => {

    statusElement.textContent = "Connected";

    socket.send(
      JSON.stringify({
        type: "join",
        roomId: roomId
      })
    );

  });


  socket.addEventListener("message", (event) => {

    const data = JSON.parse(event.data);

    handleMessage(data);

  });


  socket.addEventListener("close", () => {

    statusElement.textContent = "Disconnected";

  });


  socket.addEventListener("error", () => {

    statusElement.textContent = "Connection error";

  });

}


// Handle incoming messages
function handleMessage(data) {

  if (data.type === "joined") {

    chatSection.classList.remove("hidden");

    addSystemMessage(
      `Joined room: ${data.roomId}`
    );

    if (data.users === 1) {

      addSystemMessage(
        "Waiting for your friend..."
      );

    }

    return;
  }


  if (data.type === "user-joined") {

    addSystemMessage(
      "Your friend joined the room 🟢"
    );

    return;
  }


  if (data.type === "user-left") {

    addSystemMessage(
      "Your friend left the room 🔴"
    );

    return;
  }


  if (data.type === "message") {

    if (data.messageType === "url") {

      addURLMessage(
        data.text
      );

    } else {

      addFriendMessage(
        data.text
      );

    }

    return;
  }


  if (data.type === "error") {

    alert(data.message);

  }

}


// Send normal message
sendBtn.addEventListener("click", sendMessage);


messageInput.addEventListener("keydown", (event) => {

  if (event.key === "Enter") {

    sendMessage();

  }

});


function sendMessage() {

  const text = messageInput.value.trim();

  if (!text) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {

    alert("Not connected.");

    return;
  }


  socket.send(
    JSON.stringify({
      type: "message",
      messageType: "text",
      text: text
    })
  );


  addMyMessage(text);

  messageInput.value = "";

}


// Send current URL
urlBtn.addEventListener("click", async () => {

  if (!socket || socket.readyState !== WebSocket.OPEN) {

    alert("Not connected.");

    return;
  }


  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });


  if (!tabs.length) {
    return;
  }


  const url = tabs[0].url;


  socket.send(
    JSON.stringify({
      type: "message",
      messageType: "url",
      text: url
    })
  );


  addURLMessage(url);

});


// Add my message
function addMyMessage(text) {

  const div = document.createElement("div");

  div.className = "message mine";

  div.textContent = `You: ${text}`;

  messagesElement.appendChild(div);

  scrollMessages();

}


// Add friend's message
function addFriendMessage(text) {

  const div = document.createElement("div");

  div.className = "message friend";

  div.textContent = `Friend: ${text}`;

  messagesElement.appendChild(div);

  scrollMessages();

}


// Add URL
function addURLMessage(url) {

  const div = document.createElement("div");

  div.className = "message friend";

  div.innerHTML = `
    Friend sent URL:
    <br>
    <a href="${escapeHTML(url)}" target="_blank">
      ${escapeHTML(url)}
    </a>
  `;

  messagesElement.appendChild(div);

  scrollMessages();

}


// System message
function addSystemMessage(text) {

  const div = document.createElement("div");

  div.className = "message system";

  div.textContent = text;

  messagesElement.appendChild(div);

  scrollMessages();

}


// Scroll chat
function scrollMessages() {

  messagesElement.scrollTop =
    messagesElement.scrollHeight;

}


// Basic HTML escaping
function escapeHTML(value) {

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

}