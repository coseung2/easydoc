import { verifySessionCredential, type DeviceRole } from "./auth.ts";
import { DurablePairingStore, type DurableStorageLike } from "./durable-pairing.ts";
import { RelayRoom } from "./room.ts";

type DurableStub = { fetch(request: Request): Promise<Response> };
type DurableNamespace = { idFromName(name: string): unknown; get(id: unknown): DurableStub };
type DurableStateLike = { storage: DurableStorageLike };

type Env = {
  ROOM: DurableNamespace;
  PAIRING: DurableNamespace;
  SESSION_SIGNING_SECRET: string;
};

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(error: unknown): Response {
  const code = error instanceof Error ? error.message : "relay_unavailable";
  const status = code === "pairing_invalid" || code === "pairing_expired" ? 401 : 400;
  return json({ error: code }, { status });
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pairing_invalid");
  return value as Record<string, unknown>;
}

function pairingStub(env: Env): DurableStub {
  return env.PAIRING.get(env.PAIRING.idFromName("global"));
}

async function proxyPairing(request: Request, env: Env, path: string, overrideBody?: unknown): Promise<Response> {
  const target = new URL(request.url);
  target.pathname = path;
  target.search = "";
  const body = overrideBody === undefined ? await request.text() : JSON.stringify(overrideBody);
  return pairingStub(env).fetch(new Request(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, protocol: 1 });

    if (request.method === "POST" && url.pathname === "/pairing/issue") return proxyPairing(request, env, "/issue");
    if (request.method === "POST" && url.pathname === "/pairing/claim") return proxyPairing(request, env, "/claim");
    if (request.method === "POST" && url.pathname === "/pairing/session") return proxyPairing(request, env, "/session");
    if (request.method === "POST" && url.pathname === "/pairing/revoke") {
      try {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7) : "";
        const credential = await verifySessionCredential(token, env.SESSION_SIGNING_SECRET);
        return proxyPairing(request, env, "/revoke", {
          roomId: credential.roomId,
          role: credential.role,
          deviceId: credential.deviceId,
        });
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (url.pathname !== "/connect" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "not_found" }, { status: 404 });
    }

    const token = url.searchParams.get("token") ?? "";
    try {
      const credential = await verifySessionCredential(token, env.SESSION_SIGNING_SECRET);
      url.searchParams.set("roomId", credential.roomId);
      return env.ROOM.get(env.ROOM.idFromName(credential.roomId)).fetch(new Request(url, request));
    } catch {
      return json({ error: "unauthorized" }, { status: 401 });
    }
  },
};

export class PairingCoordinator {
  private readonly store: DurablePairingStore;
  private readonly env: Env;

  constructor(state: DurableStateLike, env: Env) {
    this.store = new DurablePairingStore(state.storage);
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
      const body = await bodyObject(request);

      if (url.pathname === "/issue") {
        return json(await this.store.issue(String(body.desktopId ?? ""), String(body.publicKey ?? "")));
      }

      if (url.pathname === "/claim") {
        const claimed = await this.store.claim(
          body.pairing as string | Record<string, unknown>,
          String(body.mobileId ?? ""),
          String(body.mobilePublicKey ?? ""),
        );
        const session = await this.store.issueSessionToken(
          claimed.relationship.roomId,
          "mobile",
          claimed.relationship.mobileId,
          claimed.mobileSecret,
          this.env.SESSION_SIGNING_SECRET,
        );
        return json({
          roomId: claimed.relationship.roomId,
          desktopId: claimed.relationship.desktopId,
          desktopPublicKey: claimed.relationship.desktopPublicKey,
          mobileSecret: claimed.mobileSecret,
          session,
        });
      }

      if (url.pathname === "/session") {
        const role = body.role;
        if (role !== "mobile" && role !== "desktop") throw new Error("pairing_invalid");
        const roomId = String(body.roomId ?? "");
        const session = await this.store.issueSessionToken(
          roomId,
          role as DeviceRole,
          String(body.deviceId ?? ""),
          String(body.bootstrapSecret ?? ""),
          this.env.SESSION_SIGNING_SECRET,
        );
        const relationship = await this.store.getRelationship(roomId);
        if (!relationship) throw new Error("pairing_invalid");
        const peerPublicKey = role === "desktop" ? relationship.mobilePublicKey : relationship.desktopPublicKey;
        return json({ ...session, peerPublicKey });
      }

      if (url.pathname === "/revoke") {
        const role = body.role;
        if (role !== "mobile" && role !== "desktop") throw new Error("pairing_invalid");
        const revoked = await this.store.revoke(String(body.roomId ?? ""), role, String(body.deviceId ?? ""));
        return json({ revoked });
      }

      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }
}

export class PairRoom {
  private readonly room = new RelayRoom();
  private readonly env: Env;

  constructor(_state: DurableStateLike, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    try {
      const credential = await verifySessionCredential(token, this.env.SESSION_SIGNING_SECRET);
      const Pair = (globalThis as typeof globalThis & { WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;
      if (!Pair) return json({ error: "websocket_unavailable" }, { status: 500 });
      const pair = new Pair();
      const client = pair[0];
      const server = pair[1] as WebSocket & { accept(): void };
      server.accept();
      this.room.attach(credential, server);
      server.addEventListener("message", (event: MessageEvent) => {
        try {
          this.room.handle(credential.role, event.data as string | ArrayBuffer);
        } catch (error) {
          server.send(JSON.stringify({ type: "relay:error", code: error instanceof Error ? error.message : "relay_unavailable" }));
        }
      });
      server.addEventListener("close", () => this.room.detach(credential.role, server));
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    } catch (error) {
      return errorResponse(error);
    }
  }
}
