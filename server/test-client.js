// Ad-hoc integration test: simulates two clients joining the same room,
// exchanging a text message + a URL message, and checking delivery/read
// receipts. Run with: node test-client.js (server must already be running).
const WebSocket = require("ws");

const URL = "ws://localhost:8080";
const roomId = "test-room-" + Date.now();

function connectClient(name, clientId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const events = [];

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", roomId, clientId }));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      events.push(msg);
      console.log(`[${name}] <-`, msg);

      // Mimic background.js: auto-acknowledge delivery of incoming messages.
      if (msg.type === "message" && msg.senderId !== clientId) {
        ws.send(JSON.stringify({ type: "delivered", messageId: msg.messageId }));
      }
    });

    ws.on("error", (err) => console.error(`[${name}] error`, err));

    resolve({ ws, events, name });
  });
}

async function main() {
  const alice = await connectClient("alice", "client-alice");
  await new Promise((r) => setTimeout(r, 300));

  const bob = await connectClient("bob", "client-bob");
  await new Promise((r) => setTimeout(r, 300));

  console.log("--- Alice sends text ---");
  alice.ws.send(
    JSON.stringify({ type: "message", messageType: "text", text: "Hello Bob!" }),
  );
  await new Promise((r) => setTimeout(r, 300));

  console.log("--- Bob sends a URL ---");
  bob.ws.send(
    JSON.stringify({
      type: "message",
      messageType: "url",
      text: "https://example.com",
    }),
  );
  await new Promise((r) => setTimeout(r, 500));

  const aliceGotText = alice.events.some(
    (e) => e.type === "message-sent" && e.text === "Hello Bob!",
  );
  const bobReceivedText = bob.events.some(
    (e) => e.type === "message" && e.text === "Hello Bob!",
  );
  const aliceGotStatus = alice.events.some(
    (e) => e.type === "message-status" && (e.status === "delivered" || e.status === "read"),
  );
  const bobGotUrl = bob.events.some(
    (e) => e.type === "message-sent" && e.messageType === "url",
  );
  const aliceReceivedUrl = alice.events.some(
    (e) => e.type === "message" && e.messageType === "url" && e.text === "https://example.com",
  );

  console.log("\n=== RESULTS ===");
  console.log("Alice message-sent echo:", aliceGotText);
  console.log("Bob received text message:", bobReceivedText);
  console.log("Alice got delivery/read status:", aliceGotStatus);
  console.log("Bob message-sent echo for URL:", bobGotUrl);
  console.log("Alice received URL message:", aliceReceivedUrl);

  const allPass =
    aliceGotText && bobReceivedText && aliceGotStatus && bobGotUrl && aliceReceivedUrl;
  console.log(allPass ? "\nALL TESTS PASSED" : "\nSOME TESTS FAILED");

  alice.ws.close();
  bob.ws.close();
  process.exit(allPass ? 0 : 1);
}

main();
