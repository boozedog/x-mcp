import { assertEquals } from "@std/assert";
import { XClient, normalizePost, POST_FIELDS } from "./x-client.ts";
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

Deno.test("normalizePost: promotes notePost.text into top-level text", () => {
  const post = {
    id: "1",
    text: "truncated...",
    notePost: { text: "the complete long-form text" },
  };
  const out = normalizePost(post);
  assertEquals(out.text, "the complete long-form text");
  // Original is not mutated.
  assertEquals(post.text, "truncated...");
});

Deno.test("normalizePost: falls back to raw note_tweet.text", () => {
  const out = normalizePost({
    id: "2",
    text: "truncated...",
    note_tweet: { text: "full text via snake_case" },
  });
  assertEquals(out.text, "full text via snake_case");
});

Deno.test("normalizePost: promotes raw note_post.text (raw:true response shape)", () => {
  // `raw: true` responses carry the snake_case field matching the requested
  // `post.fields=note_post`, so this is the shape production actually returns.
  const out = normalizePost({
    id: "5",
    text: "truncated...",
    note_post: { text: "full text via note_post" },
  });
  assertEquals(out.text, "full text via note_post");
});

Deno.test("normalizePost: ordinary posts are unchanged", () => {
  const post = { id: "3", text: "a normal short post" };
  assertEquals(normalizePost(post), post);
});

Deno.test("normalizePost: empty note text leaves top-level text unchanged", () => {
  const post = { id: "4", text: "keep me", notePost: { text: "" } };
  assertEquals(normalizePost(post).text, "keep me");
});

Deno.test("x-client: POST_FIELDS requests the note_post field", () => {
  // getPost and getBookmarksPage both pass POST_FIELDS as postFields, so the
  // X API request must include note_post (the XDK name for note_tweet).
  assertEquals(POST_FIELDS.includes("note_post"), true);
});
