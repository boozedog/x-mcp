import { assertEquals } from "@std/assert";
import { XClient } from "./x-client.ts";
import type { Auth } from "./auth-store.ts";

function auth(over: Partial<Auth> = {}): Auth {
  return {
    access_token: "at",
    refresh_token: "rt",
    token_type: "Bearer",
    scope: "offline.access",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

Deno.test("x-client: refresh persists rotated tokens", async () => {
  const originalFetch = globalThis.fetch;
  const saved: { value: Auth | null } = { value: null };
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "offline.access",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    )) as typeof fetch;
  try {
    const client = new XClient(
      auth({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
      "cid",
      async (a) => {
        saved.value = a;
      },
    );
    await client.refreshIfNeeded();
    assertEquals(saved.value?.access_token, "new-at");
    assertEquals(saved.value?.refresh_token, "new-rt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
