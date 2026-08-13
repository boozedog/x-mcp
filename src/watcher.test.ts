import { assertEquals } from "@std/assert";
import { Store } from "./db.ts";
import { pollBookmarks } from "./watcher.ts";

// Fake client that serves page1 then a "next_token" page, and never touches folders.
const calls: string[] = [];
const client = {
  rate: { remaining: 50, reset: null },
  async getBookmarksPage(_uid: string, token?: string) {
    calls.push(token ?? "(first)");
    if (!token) return { data: [{ id: "new1" }, { id: "new2" }], meta: { next_token: "tok2" } };
    return { data: [{ id: "old1" }, { id: "p1" }], meta: {} };
  },
} as never;

Deno.test("poller: backfills until overlap, upserts edges, no folder calls", async () => {
  calls.length = 0;
  const store = new Store(":memory:");
  // Pre-existing known bookmark "p1" so the second page overlaps.
  store.upsertBookmark("me", "p1", { id: "p1" });
  const res = await pollBookmarks(store, client as never, "me", { pageCap: 10 });
  assertEquals(res.stopped, "overlap");
  // Page 1 (new1, new2) is all-new so we keep paging; page 2 (old1, p1) overlaps
  // on p1. new1, new2, old1 are new; p1 was already known.
  assertEquals(res.newEdges, 3);
  assertEquals(calls.length, 2); // page 1 + page 2
  const ids = [...store.bookmarkIds()].sort();
  assertEquals(ids, ["new1", "new2", "old1", "p1"]);
  // list_bookmarks answers from SQL
  const listed = store.bookmarks(100);
  assertEquals(listed.length, 4);
  // No folder endpoints were called (only default bookmarks).
  assertEquals(calls.some((c) => c.includes("folder")), false);
});

Deno.test("poller: backfill mode pages past overlap to reach older bookmarks", async () => {
  calls.length = 0;
  const store = new Store(":memory:");
  // Pre-seed the newest bookmark so page 1 overlaps immediately.
  store.upsertBookmark("me", "new1", { id: "new1" });
  const res = await pollBookmarks(store, client as never, "me", {
    pageCap: 10,
    backfill: true,
  });
  // In backfill mode we keep paging past the overlap on page 1; page 2 has no
  // next_token so it exhausts.
  assertEquals(res.stopped, "exhausted");
  assertEquals(calls.length, 2); // page 1 + page 2 both fetched
  const ids = [...store.bookmarkIds()].sort();
  assertEquals(ids, ["new1", "new2", "old1", "p1"]);
});

Deno.test("poller: bookmark fetch stores complete long-form text", async () => {
  const store = new Store(":memory:");
  // The real XClient normalizes notePost.text into top-level text before the
  // watcher caches it, so the fake client returns the already-normalized post.
  const longClient = {
    rate: { remaining: 50, reset: null },
    async getBookmarksPage() {
      return {
        data: [{
          id: "long1",
          text: "the complete long-form text",
          notePost: { text: "the complete long-form text" },
        }],
        meta: {},
      };
    },
  } as never;
  const res = await pollBookmarks(store, longClient as never, "me", { pageCap: 1 });
  assertEquals(res.newEdges, 1);
  const stored = store.post("long1");
  assertEquals(JSON.parse(stored?.json ?? "{}").text, "the complete long-form text");
});
