import { assertEquals } from "@std/assert";
import { Store } from "./db.ts";
import { Logger } from "./logger.ts";
import { makeHandler } from "./server.ts";
import { buildHttpHandler } from "./http.ts";
import type { HealthData } from "./status.ts";

const health: HealthData = {
  ok: true,
  has_auth_file: true,
  token_expired: false,
  sqlite_posts: 3,
  sqlite_users: 2,
  sqlite_bookmarks: 4,
  last_poll_at: "2026-08-14T00:00:00Z",
  last_new_count: 2,
  last_poll_error: null,
  rate_limit_remaining: 45,
  rate_limit_reset: 1234567890,
};

function makeHttp(mcpHandler: ReturnType<typeof makeHandler> | null = null) {
  const log = new Logger("error");
  return buildHttpHandler({
    log,
    mcpHandler,
    getHealth: () => health,
  });
}

Deno.test("http: GET / returns 200 HTML status page with health fields", async () => {
  const handler = makeHttp();
  const res = await handler(new Request("http://127.0.0.1/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await res.text();
  assertEquals(body.includes("<!doctype html>"), true);
  assertEquals(body.includes("Cached posts"), true);
  assertEquals(body.includes("Cached bookmarks"), true);
  assertEquals(body.includes(">3<"), true); // posts count
  assertEquals(body.includes(">4<"), true); // bookmarks count
});

Deno.test("http: GET /health returns JSON with no token values and full field set", async () => {
  const handler = makeHttp();
  const res = await handler(new Request("http://127.0.0.1/health"));
  assertEquals(res.status, 200);
  const data = await res.json();
  // Full issue #1 field set.
  assertEquals(data.ok, true);
  assertEquals(data.has_auth_file, true);
  assertEquals(data.token_expired, false);
  assertEquals(data.sqlite_posts, 3);
  assertEquals(data.sqlite_users, 2);
  assertEquals(data.sqlite_bookmarks, 4);
  assertEquals(data.last_poll_at, "2026-08-14T00:00:00Z");
  assertEquals(data.last_new_count, 2);
  assertEquals(data.rate_limit_remaining, 45);
  assertEquals(data.rate_limit_reset, 1234567890);
  // No token keys.
  assertEquals("access_token" in data, false);
  assertEquals("refresh_token" in data, false);
  assertEquals("auth.json" in data, false);
});

Deno.test("http: status page contains no token values", async () => {
  const handler = makeHttp();
  const res = await handler(new Request("http://127.0.0.1/"));
  const body = await res.text();
  assertEquals(body.includes("access_token"), false);
  assertEquals(body.includes("refresh_token"), false);
  assertEquals(body.includes("auth.json"), false);
});

Deno.test("http: unknown route returns 404", async () => {
  const handler = makeHttp();
  const res = await handler(new Request("http://127.0.0.1/nope"));
  assertEquals(res.status, 404);
});

Deno.test("http: /mcp and /mcp/ both route to the MCP handler", async () => {
  const store = new Store(":memory:");
  const log = new Logger("error");
  const mcpHandler = makeHandler(store, {
    rate: { remaining: 50, reset: null },
    async getMe() {
      return { data: { id: "me1", username: "operator" } };
    },
  } as never);
  const handler = buildHttpHandler({
    log,
    mcpHandler,
    getHealth: () => health,
  });
  for (const path of ["/mcp", "/mcp/"]) {
    const res = await handler(
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    assertEquals(res.status, 200);
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
    const names = (JSON.parse(data ?? "{}")?.result?.tools ?? []).map(
      (t: { name: string }) => t.name,
    );
    assertEquals(names, ["get_me", "get_user", "get_post", "list_bookmarks", "refresh_bookmarks"]);
  }
});

Deno.test("http: /mcp without a handler returns 404", async () => {
  const handler = makeHttp();
  const res = await handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  assertEquals(res.status, 404);
});

Deno.test("http: / and /health are GET-only (POST returns 404)", async () => {
  const handler = makeHttp();
  for (const path of ["/", "/health"]) {
    const res = await handler(
      new Request(`http://127.0.0.1${path}`, { method: "POST" }),
    );
    assertEquals(res.status, 404);
  }
});
