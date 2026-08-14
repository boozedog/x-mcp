/**
 * In-process bookmark poller (issue #1).
 *
 * No bookmark stream exists, so the watcher polls `GET /2/users/{id}/bookmarks`
 * (newest first) and upserts default-folder edges into SQLite. It shares the
 * XClient's refresh mutex and rate-limit gate with the MCP tools.
 *
 * Polling rules:
 *   1. Backfill pages until overlap with a known id OR a per-tick page cap.
 *   2. Steady state: page 1 only, max_results=50 (see x-client.ts for the
 *      documented deviation from the spec's 100). Stop if last id already known.
 *   3. Gap: if page 1 is all new, keep paging until a known id or the cap.
 *   4. Interval is a flag (default 180s).
 *   5. Edges are append-only in v1; unbookmarks are ignored.
 *   6. Folders are skipped. No folder endpoints.
 *   7. Watcher and tools share the rate gate. If remaining is low, skip the tick.
 *   8. Same function drives the timer and the `refresh_bookmarks` tool.
 */
import type { Store } from "./db.ts";
import type { XClient } from "./x-client.ts";

const DEFAULT_PAGE_CAP = 10;

export interface PollResult {
  fetched: number;
  newEdges: number;
  stopped: "overlap" | "cap" | "exhausted" | "skipped";
  error?: string;
}

/**
 * Run one poller tick. Returns a summary; never throws — callers should surface
 * the summary (or a logged error) instead of letting a 429 take the process down.
 */
export async function pollBookmarks(
  store: Store,
  client: XClient,
  userId: string,
  opts: { pageCap?: number; allowWhenRateLimited?: boolean; backfill?: boolean } = {},
): Promise<PollResult> {
  // If the shared gate says we are out of quota and not yet reset, skip the tick.
  if (!opts.allowWhenRateLimited) {
    const { remaining, reset } = client.rate;
    if (remaining !== null && remaining <= 0 && reset !== null) {
      const now = Math.floor(Date.now() / 1000);
      if (reset > now) {
        return { fetched: 0, newEdges: 0, stopped: "skipped" };
      }
    }
  }

  // Snapshot of ids known BEFORE this tick. Overlap is judged against this set,
  // not the growing set, so an all-new page 1 keeps paging (spec rule 3).
  const knownBefore = store.bookmarkIds();
  const known = new Set(knownBefore);
  const cap = opts.pageCap ?? DEFAULT_PAGE_CAP;
  let nextToken: string | undefined;
  let fetched = 0;
  let newEdges = 0;

  for (let page = 0; page < cap; page++) {
    let resp;
    try {
      resp = await client.getBookmarksPage(userId, nextToken);
    } catch (err) {
      return {
        fetched,
        newEdges,
        stopped: page === 0 ? "skipped" : "cap",
        error: err instanceof Error ? err.message : "poll failed",
      };
    }

    const posts = resp.data ?? [];
    if (posts.length === 0) {
      return { fetched, newEdges, stopped: "exhausted" };
    }

    for (const post of posts) {
      store.upsertBookmark(userId, post.id, post);
      fetched++;
      if (!known.has(post.id)) newEdges++;
      known.add(post.id);
    }

    // Upsert any included users/posts too (default rule: every post & user from a response).
    for (const u of resp.includes?.users ?? []) store.upsertUser(u.id, u.username ?? "", u);
    for (const p of resp.includes?.posts ?? []) store.upsertPost(p.id, p);

    const next = resp.meta?.next_token ?? resp.meta?.nextToken;
    // Overlap = any post on this page was already known before this tick.
    const overlapped = posts.some((p) => knownBefore.has(p.id));
    // In steady state, stop at the first overlap (newest page is already known).
    // In backfill mode, keep paging past overlap to reach older bookmarks.
    if (overlapped && !opts.backfill) return { fetched, newEdges, stopped: "overlap" };
    if (!next) return { fetched, newEdges, stopped: "exhausted" };
    nextToken = next;
  }
  return { fetched, newEdges, stopped: "cap" };
}
