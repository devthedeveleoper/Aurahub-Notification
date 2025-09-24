import { Hono } from "hono";

interface NotificationMessage {
  _id: string;
  sender: { username: string };
  type: "like" | "comment" | "reply";
  video: { _id: string; title: string };
  createdAt: string;
}

type Bindings = {
  NOTIFICATION_HUB: DurableObjectNamespace;
};

const allowedOrigins = ["http://localhost:3000", "https://www.aurahub.fun"];

export class NotificationHub {
  state: DurableObjectState;
  sessions: WebSocket[];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sessions = [];
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/notify") {
      const { message } = await request.json<{
        message: NotificationMessage;
      }>();
      this.broadcast(JSON.stringify(message));
      return new Response("Notification sent");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  handleSession(webSocket: WebSocket) {
    webSocket.accept();
    this.sessions.push(webSocket);

    const closeOrErrorHandler = () => {
      this.sessions = this.sessions.filter((session) => session !== webSocket);
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);
  }

  broadcast(message: string) {
    this.sessions.forEach((session) => {
      try {
        session.send(message);
      } catch (err) {
        this.sessions = this.sessions.filter((s) => s !== session);
      }
    });
  }
}

const app = new Hono<{ Bindings: Bindings }>();

app.post("/api/notify/:userId", async (c) => {
  const userId = c.req.param("userId");
  const message = await c.req.json();

  const id = c.env.NOTIFICATION_HUB.idFromName(userId);
  const stub = c.env.NOTIFICATION_HUB.get(id);

  await stub.fetch(
    new Request(`https://internal-worker.com/notify`, {
      method: "POST",
      body: JSON.stringify({ message }),
    })
  );

  return c.json({ success: true });
});

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext
  ): Promise<Response> {
    const origin = request.headers.get("Origin");
    const upgradeHeader = request.headers.get("Upgrade");

    if (
      upgradeHeader === "websocket" &&
      origin &&
      !allowedOrigins.includes(origin)
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return app.fetch(request, env, ctx);
    }

    const id = env.NOTIFICATION_HUB.idFromName(userId);
    const stub = env.NOTIFICATION_HUB.get(id);

    return stub.fetch(request);
  },
};
