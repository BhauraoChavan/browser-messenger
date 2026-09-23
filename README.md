# Browser Messenger

A lightweight Chrome extension that lets two people chat **directly through their
browsers** after joining the same *Room ID*. It supports plain text messages,
link sharing (send the current tab's URL with one click), delivery/read receipts,
desktop notifications, and automatic reconnection.

The project has two parts:

| Folder      | What it is                                                        |
| ----------- | ----------------------------------------------------------------- |
| `server/`   | A tiny Node.js + `ws` WebSocket relay server (rooms of max 2 users) |
| `extension/`| The Chrome (Manifest V3) extension: popup UI + background worker   |

---

## Features

- **Two-user rooms** – share a Room ID; only two participants are allowed per room.
- **Text chat** – messages are relayed in real time.
- **Share current tab URL** – press 🔗 to send the active tab's link, rendered as a
  clickable link in the chat.
- **Delivery / read receipts** – `✓` sent, `✓✓` delivered, blue `✓✓` read.
- **System notices** – tells you when your friend joins or leaves.
- **Desktop notifications** – get notified of new messages even when the popup is closed.
- **Message history** – the last 500 messages per room are replayed when you rejoin;
  history is also cached locally in the browser.
- **Auto-reconnect** – reconnects automatically after the connection drops.
- **Heartbeat** – keeps the WebSocket alive.

---

## 1. Run the server

```bash
cd server
npm install
npm start
```

The server listens on `http://localhost:8080` (or `PORT` if set) and will log
`WebSocket server running on port <PORT>`.

### Deploying

The extension is configured to talk to `wss://browser-messenger.onrender.com`
(see `SERVER_URL` in `extension/background.js`). Deploy the `server/` folder to
any host that supports WebSockets (Render, Railway, Fly.io, etc.), then update
`SERVER_URL` to your deployment URL.

`server/package.json` already provides a `start` script (`node server.js`), which
most platforms detect automatically.

---

## 2. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension to the toolbar.

To use your locally running server, change the first line of
`extension/background.js`:

```js
const SERVER_URL = "ws://localhost:8080";
```

---

## 3. Chat

1. Both users click the extension icon.
2. Both enter the **same Room ID** and click **Connect**.
3. When the status shows *Connected* and the presence indicator shows
   **🟢 Friend online**, start typing.
4. Use the 🔗 button to send the URL of the tab you are currently on.
5. Use **Disconnect** to leave the room.

---

## Architecture

```
extension/popup.js  ──messages──▶  extension/background.js  ──WebSocket──▶  server/server.js
   (UI)                              (socket + state)                        (room relay)
```

### WebSocket protocol

Client → Server

| Type        | Payload                                   | Description                    |
| ----------- | ----------------------------------------- | ------------------------------ |
| `join`      | `{ roomId, clientId }`                     | Join (or create) a room        |
| `message`   | `{ messageType, text }`                    | Send a message (`text`/`url`)  |
| `delivered` | `{ messageId }`                            | Mark a message delivered       |
| `read`      | `{ messageId }`                            | Mark a message read            |
| `ping`      | `{}`                                       | Heartbeat                      |

Server → Client

| Type             | Payload                                        | Description                        |
| ---------------- | ---------------------------------------------- | ---------------------------------- |
| `joined`         | `{ roomId, users }`                             | Join confirmation + user count     |
| `user-joined`    | `{}`                                            | The other user joined              |
| `user-left`      | `{}`                                            | The other user left                |
| `message`        | `{ messageId, messageType, text, senderId, createdAt, history? }` | Incoming message (history replay) |
| `message-sent`   | `{ messageId, messageType, text, senderId, createdAt }` | Echo of your own message           |
| `message-status` | `{ messageId, status }`                         | `sent` / `delivered` / `read`      |
| `error`          | `{ message }`                                   | Error (e.g. room full)             |

---

## Notes & limits

- Messages are kept in memory on the server (last **500 per room**) and are cleared
  when the server restarts. Rooms with no clients and no messages are freed.
- Maximum message length is **2000** characters; maximum Room ID length is **100**.
- This is a simple relay: it does **not** end-to-end encrypt messages. Do not use it
  for sensitive data.
- Each room holds at most **2** users; a third connection is rejected with
  *"Room is full"*.

---

## License

ISC