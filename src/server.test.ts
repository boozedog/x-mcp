import { assertEquals } from "@std/assert";
import { Store } from "./db.ts";
import { makeHandler } from "./server.ts";
import { RateLimitError, NotFoundError } from "./x-client.ts";

/** Fake XClient that throws RateLimitError on getPost. */
function rateLimitedClient() {
  return {
    rate: { remaining: 0, reset: Math.floor(Date.now() / 1000) + 60 },
    async getMe() {
      return { data: { id: "me1", username: "operator" } };
    },
    async getPost() {
      throw new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    },
    async getUserById() {
      throw new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    },
    async getUserByUsername() {
      throw new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    },
    async getBookmarksPage() {
      throw new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    },
  } as never;
}

async function callTool(handler: ReturnType<typeof makeHandler>, name: string, args: unknown) {
  const res = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return data ? JSON.parse(data) : null;
}

Deno.test("server: 429 on get_post with no cache returns isError, does not crash", async () => {
  const store = new Store(":memory:");
  const handler = makeHandler(store, rateLimitedClient());
  const msg = await callTool(handler, "get_post", { id: "1" });
  assertEquals(msg?.result?.isError, true);
});

Deno.test("server: 429 on get_post with a stale cached copy returns the stale copy", async () => {
  const store = new Store(":memory:");
  store.upsertPost("1", { id: "1", text: "stale" });
  const handler = makeHandler(store, rateLimitedClient());
  const msg = await callTool(handler, "get_post", { id: "1" });
  // The stale copy is served from cache before any X call, so no error.
  assertEquals(msg?.result?.isError, undefined);
  assertEquals(JSON.parse(msg?.result?.content?.[0]?.text ?? "{}").text, "stale");
});

Deno.test("server: 429 with fresh:true returns stale copy + reset, not isError", async () => {
  const store = new Store(":memory:");
  store.upsertPost("1", { id: "1", text: "stale" });
  const handler = makeHandler(store, rateLimitedClient());
  const msg = await callTool(handler, "get_post", { id: "1", fresh: true });
  // fresh:true forces the X call -> 429 -> stale fallback with reset time.
  assertEquals(msg?.result?.isError, undefined);
  assertEquals(msg?.result?.structuredContent?.stale, true);
  assertEquals(typeof msg?.result?.structuredContent?.rate_limit_reset, "number");
  assertEquals(JSON.parse(msg?.result?.content?.[0]?.text ?? "{}").text, "stale");
});

Deno.test("server: 429 with fresh:true and no cache returns isError with reset", async () => {
  const store = new Store(":memory:");
  const handler = makeHandler(store, rateLimitedClient());
  const msg = await callTool(handler, "get_post", { id: "999", fresh: true });
  assertEquals(msg?.result?.isError, true);
  assertEquals(typeof msg?.result?.content?.[0]?.text, "string");
});

Deno.test("server: get_user 404 tombstones the user", async () => {
  const store = new Store(":memory:");
  store.upsertUser("u1", "alice", { id: "u1", username: "alice" });
  const client = {
    rate: { remaining: 50, reset: null },
    async getUserById() {
      throw new NotFoundError("u1");
    },
  } as never;
  const handler = makeHandler(store, client as never);
  const msg = await callTool(handler, "get_user", { id: "u1", fresh: true });
  assertEquals(msg?.result?.isError, true);
  // Tombstoned row must not be returned as live.
  assertEquals(store.user("u1"), undefined);
});

Deno.test("server: tools/list exposes exactly the five v1 tools", async () => {
  const store = new Store(":memory:");
  const handler = makeHandler(store, rateLimitedClient());
  const res = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  const names = (JSON.parse(data ?? "{}")?.result?.tools ?? []).map((t: { name: string }) => t.name);
  assertEquals(names, ["get_me", "get_user", "get_post", "list_bookmarks", "refresh_bookmarks"]);
});

Deno.test("server: list_bookmarks sort=created orders by tweet created_at", async () => {
  const store = new Store(":memory:");
  store.upsertBookmark("me", "old", { id: "old", created_at: "2020-01-01T00:00:00Z" });
  store.upsertBookmark("me", "new", { id: "new", created_at: "2024-01-01T00:00:00Z" });
  const handler = makeHandler(store, rateLimitedClient());
  const msg = await callTool(handler, "list_bookmarks", { sort: "created" });
  const items = JSON.parse(msg?.result?.content?.[0]?.text ?? "[]") as { id: string }[];
  assertEquals(items[0].id, "new");
  assertEquals(items[1].id, "old");
});
