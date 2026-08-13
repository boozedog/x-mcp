/**
 * MCP server wiring (issue #1). Streamable HTTP via `createMcpHandler`.
 *
 * Exposes exactly five read-only v1 tools:
 *   get_me, get_user, get_post, list_bookmarks, refresh_bookmarks
 *
 * Every tool uses an Effect v4 schema converted through
 * `Schema.toStandardSchemaV1` + `Schema.toStandardJSONSchemaV1` (see mcp-schema.ts).
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { toMcpInputSchema, NoArgs } from "./mcp-schema.ts";
import type { Store } from "./db.ts";
import { RateLimitError, NotFoundError, type XClient } from "./x-client.ts";
import { pollBookmarks } from "./watcher.ts";

/** Build an isError result carrying the rate-limit reset time. */
function rateLimitedResult(reset: number): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    content: [{ type: "text", text: `X rate limit exceeded; retry after ${reset}` }],
  };
}

/** Return a stale cached row (if any) or an isError with reset time on 429. */
function staleOrRateLimited<T>(
  cached: { json: string } | undefined,
  reset: number,
): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> } | {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  if (cached) {
    return {
      content: [{ type: "text", text: cached.json }],
      structuredContent: { from_cache: true, stale: true, rate_limit_reset: reset },
    };
  }
  return rateLimitedResult(reset);
}

const GetUserInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  fresh: Schema.optional(Schema.Boolean),
});

const GetPostInput = Schema.Struct({
  id: Schema.String,
  fresh: Schema.optional(Schema.Boolean),
});

const ListBookmarksInput = Schema.Struct({
  limit: Schema.optional(Schema.Number),
});

/** Upsert a user plus any included entities from a response. */
function cacheUser(store: Store, user: { id: string; username?: string } | undefined) {
  if (user) store.upsertUser(user.id, user.username ?? "", user);
}

export function makeHandler(store: Store, client: XClient) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "x", version: "1.0.0" });
    server.registerTool(
      "get_me",
      {
        description: "Get the authenticated user. Caches the user row.",
        inputSchema: toMcpInputSchema(NoArgs),
      },
      async () => {
        try {
          const resp = await client.getMe();
          cacheUser(store, resp.data);
          // Remember our own id so the poller can target it.
          if (resp.data?.id) store.setMeta("me_id", resp.data.id);
          return { content: [{ type: "text" as const, text: JSON.stringify(resp.data) }] };
        } catch (err) {
          if (err instanceof RateLimitError) {
            const cached = store.meta("me_id")
              ? store.user(store.meta("me_id") as string)
              : undefined;
            return staleOrRateLimited(cached, err.reset);
          }
          throw err;
        }
      },
    );

    server.registerTool(
      "get_user",
      {
        description:
          "Get a user by id or username. Serves from the local cache first unless fresh: true.",
        inputSchema: toMcpInputSchema(GetUserInput),
      },
      async (rawArgs: unknown) => {
        const { id, username, fresh } = (rawArgs ?? {}) as {
          id?: string;
          username?: string;
          fresh?: boolean;
        };
        if (!id && !username) throw new Error("get_user requires an id or username");
        if (!fresh) {
          const cached = id
            ? store.user(id)
            : store.userByUsername(username as string);
          if (cached) {
            return {
              content: [{ type: "text" as const, text: cached.json }],
              structuredContent: { from_cache: true },
            };
          }
        }
        try {
          const resp = id
            ? await client.getUserById(id)
            : await client.getUserByUsername(username as string);
          cacheUser(store, resp.data);
          for (const u of resp.includes?.users ?? []) store.upsertUser(u.id, u.username ?? "", u);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(resp.data) }],
            structuredContent: { from_cache: false },
          };
        } catch (err) {
          if (err instanceof RateLimitError) {
            const cached = id ? store.user(id) : store.userByUsername(username as string);
            return staleOrRateLimited(cached, err.reset);
          }
          if (err instanceof NotFoundError || (err as { status?: number }).status === 404) {
            if (id) store.tombstoneUser(id);
            return {
              isError: true,
              content: [{ type: "text" as const, text: "user not found (tombstoned)" }],
            };
          }
          throw err;
        }
      },
    );

    server.registerTool(
      "get_post",
      {
        description:
          "Get a post by id. Serves from the local cache unless fresh: true. Tombstones X-404s.",
        inputSchema: toMcpInputSchema(GetPostInput),
      },
      async (rawArgs: unknown) => {
        const { id, fresh } = (rawArgs ?? {}) as { id: string; fresh?: boolean };
        if (!fresh) {
          const cached = store.post(id);
          if (cached) {
            return {
              content: [{ type: "text" as const, text: cached.json }],
              structuredContent: { from_cache: true },
            };
          }
        }
        try {
          const resp = await client.getPost(id);
          if (resp.data) store.upsertPost(id, resp.data);
          for (const u of resp.includes?.users ?? []) store.upsertUser(u.id, u.username ?? "", u);
          for (const p of resp.includes?.posts ?? []) store.upsertPost(p.id, p);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(resp.data) }],
            structuredContent: { from_cache: false },
          };
        } catch (err) {
          if (err instanceof RateLimitError) {
            return staleOrRateLimited(store.post(id), err.reset);
          }
          // 404 / withheld: tombstone, and fall back to a cached copy if one exists.
          if (err instanceof NotFoundError || (err as { status?: number }).status === 404) {
            store.tombstonePost(id);
            const cached = store.post(id);
            if (cached) {
              return {
                content: [{ type: "text" as const, text: cached.json }],
                structuredContent: { from_cache: true, tombstoned: true },
              };
            }
            return {
              isError: true,
              content: [{ type: "text" as const, text: "post not found (tombstoned)" }],
            };
          }
          throw err;
        }
      },
    );

    server.registerTool(
      "list_bookmarks",
      {
        description:
          "List cached bookmarks (default folder only) from SQLite. No X call.",
        inputSchema: toMcpInputSchema(ListBookmarksInput),
      },
      async (rawArgs: unknown) => {
        const { limit } = (rawArgs ?? {}) as { limit?: number };
        const items = store.bookmarks(limit ?? 25);
        return { content: [{ type: "text" as const, text: JSON.stringify(items) }] };
      },
    );

    server.registerTool(
      "refresh_bookmarks",
      {
        description: "Run one bookmark poller tick now.",
        inputSchema: toMcpInputSchema(NoArgs),
      },
      async () => {
        const meId = store.meta("me_id");
        if (!meId) {
          const me = await client.getMe();
          if (!me.data?.id) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "could not resolve authenticated user id" }],
            };
          }
          store.setMeta("me_id", me.data.id);
          cacheUser(store, me.data);
        }
        const res = await pollBookmarks(store, client, store.meta("me_id") as string, {
          allowWhenRateLimited: true,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(res) },
          ],
        };
      },
    );
    return server;
  });
}

/** Shared helper used by health / tests to expose a token-free summary. */
export function mcpToolNames(): string[] {
  return ["get_me", "get_user", "get_post", "list_bookmarks", "refresh_bookmarks"];
}

export { RateLimitError };
