/**
 * Token-free browser status screen (issue #1 follow-up).
 *
 * Serves a dependency-free HTML page at `/` with inline CSS/JS. It renders the
 * same token-free health data as `/health` and auto-refreshes via a small
 * fetch loop. No frontend dependency, no tokens, safe escaping.
 */

/** Shape of the token-free health payload shared by `/health` and `/`. */
export interface HealthData {
  ok: boolean;
  has_auth_file: boolean;
  token_expired: boolean;
  sqlite_posts: number;
  sqlite_users: number;
  sqlite_bookmarks: number;
  last_poll_at: string | null;
  last_new_count: number;
  last_poll_error: string | null;
  rate_limit_remaining: number | null;
  rate_limit_reset: number | null;
}

/** HTML-escape a string for safe interpolation into markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for safe embedding inside a `<script>` block. Replaces `<`
 * with the unicode escape so a value can never close the script tag, even if it
 * contains attacker-controlled text (e.g. a poll error message).
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Render the full HTML status page from a token-free health snapshot. */
export function renderStatusPage(health: HealthData): string {
  const fmt = (v: string | null): string => v ?? "—";
  const yesNo = (v: boolean): string => (v ? "yes" : "no");
  const resetIso = health.rate_limit_reset
    ? new Date(health.rate_limit_reset * 1000).toISOString()
    : null;

  const rows: [string, string][] = [
    ["Server", health.ok ? "ok" : "degraded"],
    ["Auth file present", yesNo(health.has_auth_file)],
    ["Token expired", yesNo(health.token_expired)],
    ["Cached posts", String(health.sqlite_posts)],
    ["Cached users", String(health.sqlite_users)],
    ["Cached bookmarks", String(health.sqlite_bookmarks)],
    ["Last poll", fmt(health.last_poll_at)],
    ["New since last poll", String(health.last_new_count)],
    ["Last poll error", fmt(health.last_poll_error)],
    [
      "Rate limit remaining",
      health.rate_limit_remaining === null ? "—" : String(health.rate_limit_remaining),
    ],
    ["Rate limit reset", fmt(resetIso)],
  ];

  const rowsHtml = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x-mcp status</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1rem;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    background: #f6f7f9; color: #1a1a1a;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  .sub { color: #6b7280; font-size: 0.9rem; margin-bottom: 1rem; }
  .card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 1rem 1.25rem; box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .badge {
    display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px;
    font-size: 0.8rem; font-weight: 600; vertical-align: middle;
  }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.bad { background: #fee2e2; color: #991b1b; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.45rem 0.25rem; border-bottom: 1px solid #eef0f2; }
  th { color: #6b7280; font-weight: 500; width: 45%; }
  .updated { font-size: 0.8rem; color: #6b7280; margin-top: 0.75rem; }
  .foot { margin-top: 0.5rem; color: #6b7280; font-size: 0.8rem; }
  /* Dark overrides come last so they win by source order over the base rules. */
  @media (prefers-color-scheme: dark) {
    body { background: #121417; color: #e6e6e6; }
    .card { background: #1c1f24; border-color: #2c3138; }
    th { color: #9aa3ad; }
    th, td { border-bottom-color: #2c3138; }
    .badge.ok { background: #14532d; color: #bbf7d0; }
    .badge.bad { background: #7f1d1d; color: #fecaca; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>x-mcp <span class="badge ${health.ok ? "ok" : "bad"}" id="badge">${health.ok ? "ok" : "degraded"}</span></h1>
  <div class="sub">Token-free status · <a href="/health">/health JSON</a></div>
  <div class="card">
    <table>
${rowsHtml}
    </table>
  </div>
  <div class="updated" id="updated">Loaded at ${escapeHtml(new Date().toISOString())}</div>
  <div class="foot">Auto-refreshes every 15s. No tokens are exposed on this page.</div>
</div>
<script type="application/json" id="health-data">${safeJson(health)}</script>
<script>
  const updated = document.getElementById("updated");
  const table = document.querySelector("table");

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function render(h) {
    const badge = document.getElementById("badge");
    badge.textContent = h.ok ? "ok" : "degraded";
    badge.className = "badge " + (h.ok ? "ok" : "bad");
    const rows = [
      ["Server", h.ok ? "ok" : "degraded"],
      ["Auth file present", h.has_auth_file ? "yes" : "no"],
      ["Token expired", h.token_expired ? "yes" : "no"],
      ["Cached posts", String(h.sqlite_posts)],
      ["Cached users", String(h.sqlite_users)],
      ["Cached bookmarks", String(h.sqlite_bookmarks)],
      ["Last poll", h.last_poll_at || "—"],
      ["New since last poll", String(h.last_new_count)],
      ["Last poll error", h.last_poll_error || "—"],
      ["Rate limit remaining", h.rate_limit_remaining === null ? "—" : String(h.rate_limit_remaining)],
      ["Rate limit reset", h.rate_limit_reset ? new Date(h.rate_limit_reset * 1000).toISOString() : "—"],
    ];
    table.innerHTML = rows.map(([k, v]) =>
      "<tr><th>" + esc(k) + "</th><td>" + esc(v) + "</td></tr>"
    ).join("");
  }

  // Initial render from the server-embedded (safeJson-escaped) snapshot.
  render(JSON.parse(document.getElementById("health-data").textContent));

  async function refresh() {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (!res.ok) throw new Error("health " + res.status);
      render(await res.json());
      updated.textContent = "Updated at " + new Date().toISOString();
    } catch (err) {
      updated.textContent = "Refresh failed: " + err.message;
    }
  }
  setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
