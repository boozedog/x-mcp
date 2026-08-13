/**
 * x-mcp CLI: login | serve | refresh
 */
import { loadAuth, saveAuth, authPath, publicAuth } from "./auth-store.ts";
import { Store } from "./db.ts";
import { XClient } from "./x-client.ts";
import { makeHandler } from "./server.ts";
import { runLogin } from "./login.ts";
import { pollBookmarks } from "./watcher.ts";
import { Logger, parseLogLevel } from "./logger.ts";

interface Opts {
  stateDir: string;
  clientId: string;
  port: number;
  pollIntervalSec: number;
  loginPort: number;
  logLevel: string;
  backfill: boolean;
  backfillPages: number;
}

function defaultStateDir(): string {
  const xdg = Deno.env.get("XDG_STATE_HOME");
  if (xdg) return `${xdg}/x-mcp`;
  const home = Deno.env.get("HOME");
  return `${home ?? "."}/.local/state/x-mcp`;
}

function parseArgs(): Opts {
  const flag = (name: string): string | undefined => {
    const i = Deno.args.indexOf(name);
    return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : undefined;
  };
  return {
    stateDir: flag("--state-dir") ?? Deno.env.get("X_MCP_STATE_DIR") ?? defaultStateDir(),
    clientId: flag("--client-id") ?? Deno.env.get("X_CLIENT_ID") ?? "",
    port: Number(flag("--port") ?? Deno.env.get("X_MCP_PORT") ?? "8788"),
    pollIntervalSec: Number(flag("--poll-interval") ?? Deno.env.get("X_MCP_POLL_INTERVAL") ?? "180"),
    loginPort: Number(flag("--login-port") ?? "8789"),
    logLevel: flag("--log-level") ?? Deno.env.get("X_MCP_LOG_LEVEL") ?? "info",
    backfill: Deno.args.includes("--backfill"),
    backfillPages: Number(flag("--backfill-pages") ?? "50"),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const command = Deno.args[0] ?? "serve";

  if (command === "login") {
    const res = await runLogin(opts.stateDir, opts.clientId, opts.loginPort);
    if (!res.ok) {
      console.error(`login failed: ${res.detail ?? "unknown error"}`);
      Deno.exit(2);
    }
    return;
  }

  if (command === "refresh") {
    const auth = await loadAuth(opts.stateDir);
    if (!auth) {
      console.error(`no auth file at ${authPath(opts.stateDir)}; run x-mcp login`);
      Deno.exit(1);
    }
    const client = new XClient(auth, opts.clientId, (a) => saveAuth(opts.stateDir, a));
    await client.refreshIfNeeded(true);
    // Re-read so we report the persisted (possibly rotated) structure.
    const fresh = await loadAuth(opts.stateDir);
    console.log(JSON.stringify(publicAuth(fresh)));
    return;
  }

  if (command !== "serve") {
    console.error(`unknown command: ${command} (expected login | serve | refresh)`);
    Deno.exit(2);
  }

  // serve
  const auth = await loadAuth(opts.stateDir);
  await Deno.mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
  const store = new Store(`${opts.stateDir}/cache.sqlite`);
  const log = new Logger(parseLogLevel(opts.logLevel));
  let client: XClient | null = null;
  if (auth) {
    client = new XClient(auth, opts.clientId, (a) => saveAuth(opts.stateDir, a), log);
  } else {
    console.error(`warning: no auth file at ${authPath(opts.stateDir)}; run x-mcp login`);
  }

  let lastPollAt: string | null = null;
  let lastNewCount = 0;
  let lastPollError: string | null = null;

  const handler = client ? makeHandler(store, client, log) : null;

  const health = (): Response => {
    const now = Math.floor(Date.now() / 1000);
    // Re-read auth so in-process refresh is reflected in health (not a start snapshot).
    const liveAuth = client ? client.authSummary() : null;
    return Response.json({
      ok: !!client,
      has_auth_file: !!liveAuth,
      token_expired: liveAuth ? liveAuth.expires_at <= now : false,
      ...store.counts(),
      last_poll_at: lastPollAt,
      last_new_count: lastNewCount,
      last_poll_error: lastPollError,
      rate_limit_remaining: client?.rate.remaining ?? null,
      rate_limit_reset: client?.rate.reset ?? null,
    });
  };

  Deno.serve({ hostname: "127.0.0.1", port: opts.port }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      log.debug(`http ${req.method} ${url.pathname}`);
      return health();
    }
    if ((url.pathname === "/mcp" || url.pathname === "/mcp/") && handler) {
      log.info(`http ${req.method} ${url.pathname}`);
      return handler.fetch(req);
    }
    log.warn(`http ${req.method} ${url.pathname} -> 404`);
    return new Response("not found", { status: 404 });
  });

  // In-process bookmark poller (issue #1).
  if (client) {
    // Resolve our own id once at startup so a fresh DB backfills without waiting
    // for a client to call get_me / refresh_bookmarks (spec: startup backfill).
    if (!store.meta("me_id")) {
      try {
        const me = await client.getMe();
        if (me.data?.id) store.setMeta("me_id", me.data.id);
        log.info(`resolved me_id=${store.meta("me_id")}`);
      } catch (err) {
        lastPollError = err instanceof Error ? err.message : "could not resolve me_id";
        log.warn(`could not resolve me_id: ${lastPollError}`);
      }
    }
    // Optional deep backfill at startup: page all the way back past overlap to
    // reach older bookmarks the steady-state poller would never fetch.
    if (opts.backfill) {
      const meId = store.meta("me_id");
      if (meId) {
        log.info(`backfill: paging up to ${opts.backfillPages} pages`);
        const res = await pollBookmarks(store, client, meId, {
          pageCap: opts.backfillPages,
          backfill: true,
          allowWhenRateLimited: true,
        });
        lastPollAt = new Date().toISOString();
        lastNewCount = res.newEdges;
        lastPollError = res.error ?? null;
        log.info(
          `backfill done fetched=${res.fetched} new=${res.newEdges} stopped=${res.stopped}` +
            (res.error ? ` error=${res.error}` : ""),
        );
      }
    }
    const tick = async (): Promise<void> => {
      const meId = store.meta("me_id");
      if (!meId) return; // resolved lazily by the first get_me / refresh_bookmarks
      const res = await pollBookmarks(store, client, meId);
      lastPollAt = new Date().toISOString();
      lastNewCount = res.newEdges;
      lastPollError = res.error ?? null;
      log.info(
        `poll fetched=${res.fetched} new=${res.newEdges} stopped=${res.stopped}` +
          (res.error ? ` error=${res.error}` : ""),
      );
    };
    const safeTick = async (): Promise<void> => {
      try {
        await tick();
      } catch (err) {
        lastPollAt = new Date().toISOString();
        lastPollError = err instanceof Error ? err.message : "poll failed";
      }
    };
    await safeTick();
    setInterval(safeTick, opts.pollIntervalSec * 1000);
  }
}

await main();
