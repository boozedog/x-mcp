import { assertEquals } from "@std/assert";
import { escapeHtml, safeJson, renderStatusPage, type HealthData } from "./status.ts";

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

Deno.test("status: escapeHtml escapes HTML metacharacters", () => {
  assertEquals(
    escapeHtml(`<script>alert("x")</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  );
});

Deno.test("status: safeJson prevents script-tag breakout", () => {
  const out = safeJson({ text: "</script><script>alert(1)</script>" });
  // The literal closing script tag must never appear in the serialized output.
  assertEquals(out.includes("</script>"), false);
  // The `<` is escaped as \u003c, which JSON.parse decodes back to `<`.
  assertEquals(out.includes("\\u003c/script>"), true);
  assertEquals(JSON.parse(out).text, "</script><script>alert(1)</script>");
});

Deno.test("status: renderStatusPage includes health fields and no tokens", () => {
  const html = renderStatusPage(health);
  assertEquals(html.includes("<!doctype html>"), true);
  assertEquals(html.includes("sqlite_posts"), true);
  assertEquals(html.includes("sqlite_bookmarks"), true);
  assertEquals(html.includes("Cached posts"), true);
  assertEquals(html.includes("Cached bookmarks"), true);
  // Counts are rendered.
  assertEquals(html.includes(">3<"), true); // posts
  assertEquals(html.includes(">4<"), true); // bookmarks
  // No token values or secret file names.
  assertEquals(html.includes("access_token"), false);
  assertEquals(html.includes("refresh_token"), false);
  assertEquals(html.includes("auth.json"), false);
});

Deno.test("status: renderStatusPage escapes attacker-controlled poll error", () => {
  const bad = { ...health, last_poll_error: `<img src=x onerror=alert(1)>` };
  const html = renderStatusPage(bad);
  // The raw tag must not appear; it must be HTML-escaped.
  assertEquals(html.includes("<img src=x onerror=alert(1)>"), false);
  assertEquals(html.includes("&lt;img src=x onerror=alert(1)&gt;"), true);
});

Deno.test("status: renderStatusPage reflects degraded state", () => {
  const bad = { ...health, ok: false, token_expired: true };
  const html = renderStatusPage(bad);
  assertEquals(html.includes("degraded"), true);
  assertEquals(html.includes(">yes<"), true); // token_expired -> yes
});

Deno.test("status: badge reflects ok state and is updatable by refresh JS", () => {
  const html = renderStatusPage(health); // ok: true
  // Badge element is present with an id so the refresh path can update it.
  assertEquals(html.includes('id="badge"'), true);
  assertEquals(html.includes('class="badge ok" id="badge"'), true);
  // The refresh render path updates both the badge text and its class.
  assertEquals(html.includes('badge.textContent = h.ok ? "ok" : "degraded"'), true);
  assertEquals(html.includes('badge.className = "badge " + (h.ok ? "ok" : "bad")'), true);
});
