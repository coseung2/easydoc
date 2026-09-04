import { verifySessionCredential } from "./auth.ts";
import { RelayRoom } from "./room.ts";

type Env = { ROOM: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }; SESSION_SIGNING_SECRET: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/connect" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("not found", { status: 404 });
    const token = url.searchParams.get("token") ?? "";
    try {
      const credential = await verifySessionCredential(token, env.SESSION_SIGNING_SECRET);
      url.searchParams.set("roomId", credential.roomId);
      return env.ROOM.get(env.ROOM.idFromName(credential.roomId)).fetch(new Request(url, request));
    } catch {
      return new Response("unauthorized", { status: 401 });
    }
  },
};

export class PairRoom {
  private readonly room = new RelayRoom();
  constructor(private readonly state: any, private readonly env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const credential = await verifySessionCredential(token, this.env.SESSION_SIGNING_SECRET);
    const Pair = (globalThis as any).WebSocketPair;
    if (!Pair) return new Response("WebSocketPair unavailable", { status: 500 });
    const pair = new Pair(); const client = pair[0]; const server = pair[1];
    server.accept(); this.room.attach(credential, server);
    server.addEventListener("message", (event: MessageEvent) => {
      try { this.room.handle(credential.role, event.data); } catch (error) { server.send(JSON.stringify({ type: "relay:error", code: error instanceof Error ? error.message : "relay_unavailable" })); }
    });
    server.addEventListener("close", () => this.room.detach(credential.role, server));
    return new Response(null, { status: 101, webSocket: client } as any);
  }
}
