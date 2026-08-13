/**
 * SQLite corpus via Deno `node:sqlite`. WAL, one writer, foreign keys on.
 *
 * Keep forever (until tombstoned):
 *   posts, users, bookmarks(user_id, post_id, folder_id), meta
 * No FTS / search_runs in v1 (that is issue #2).
 */
import { DatabaseSync } from "node:sqlite";

export interface PostRow {
  id: string;
  json: string;
  first_seen_at: string;
  last_seen_at: string;
  deleted_at: string | null;
}

export interface UserRow {
  id: string;
  username: string;
  json: string;
  first_seen_at: string;
  last_seen_at: string;
  deleted_at: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS bookmarks (
        user_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        folder_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (user_id, post_id, folder_id)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_deleted ON bookmarks(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(deleted_at);
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  upsertPost(id: string, value: unknown): void {
    const n = this.now();
    this.db
      .prepare(
        `INSERT INTO posts(id, json, first_seen_at, last_seen_at, deleted_at)
         VALUES(?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           last_seen_at = excluded.last_seen_at,
           deleted_at = NULL`,
      )
      .run(id, JSON.stringify(value), n, n);
  }

  upsertUser(id: string, username: string, value: unknown): void {
    const n = this.now();
    this.db
      .prepare(
        `INSERT INTO users(id, username, json, first_seen_at, last_seen_at, deleted_at)
         VALUES(?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           json = excluded.json,
           last_seen_at = excluded.last_seen_at,
           deleted_at = NULL`,
      )
      .run(id, username, JSON.stringify(value), n, n);
  }

  upsertBookmark(userId: string, postId: string, value: unknown): void {
    this.upsertPost(postId, value);
    const n = this.now();
    // v1 uses a non-NULL sentinel folder_id so the composite PK dedupes correctly
    // (SQLite treats NULL != NULL in UNIQUE/PK). No folder endpoints are used.
    this.db
      .prepare(
        `INSERT INTO bookmarks(user_id, post_id, folder_id, first_seen_at, last_seen_at, deleted_at)
         VALUES(?, ?, '', ?, ?, NULL)
         ON CONFLICT(user_id, post_id, folder_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           deleted_at = NULL`,
      )
      .run(userId, postId, n, n);
  }

  post(id: string): PostRow | undefined {
    return this.db
      .prepare("SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL")
      .get(id) as PostRow | undefined;
  }

  user(id: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
      .get(id) as UserRow | undefined;
  }

  userByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL")
      .get(username) as UserRow | undefined;
  }

  tombstonePost(id: string): void {
    this.db
      .prepare("UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(this.now(), id);
  }

  tombstoneUser(id: string): void {
    this.db
      .prepare("UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(this.now(), id);
  }

  /** List cached bookmark post jsons, newest first. */
  bookmarks(limit = 25, sort: "created" | "first_seen" = "first_seen"): unknown[] {
    const orderBy = sort === "created"
      ? "json_extract(p.json, '$.created_at') DESC"
      : "b.first_seen_at DESC";
    const rows = this.db
      .prepare(
        `SELECT p.json AS json
         FROM bookmarks b
         JOIN posts p ON p.id = b.post_id
         WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(limit);
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  /** Set of post ids currently bookmarked (for overlap detection). */
  bookmarkIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT post_id FROM bookmarks WHERE deleted_at IS NULL")
      .all() as { post_id: string }[];
    return new Set(rows.map((r) => r.post_id));
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  meta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  counts(): { sqlite_posts: number; sqlite_users: number; sqlite_bookmarks: number } {
    const count = (t: string): number =>
      (this.db.prepare(`SELECT count(*) AS c FROM ${t} WHERE deleted_at IS NULL`).get() as { c: number }).c;
    return {
      sqlite_posts: count("posts"),
      sqlite_users: count("users"),
      sqlite_bookmarks: count("bookmarks"),
    };
  }
}
