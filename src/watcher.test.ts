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
