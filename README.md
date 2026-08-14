# x-mcp

Personal [MCP](https://modelcontextprotocol.io) server for the [X API](https://docs.x.com) (Twitter).

It is a long-running Deno process that:

- speaks official MCP TypeScript SDK **v2** over Streamable HTTP
- talks to X through the official TypeScript [XDK](https://github.com/xdevplatform/xdk-typescript) (`@xdevplatform/xdk`)
- uses a **public** OAuth 2.0 client (PKCE + `offline.access`, no client secret)
- persists every retrieved post, user, and bookmark edge in local SQLite
- polls bookmarks 24×7 so the local corpus grows while you are not chatting

Intended to sit next to [LiteLLM](https://docs.litellm.ai/docs/mcp) on a NixOS host. The app lives in this repo. Fleet wiring (systemd enable, Tailscale Serve, LiteLLM `mcp_servers`) stays in `nixos-infra`.

**Status:** v1 implemented (cache + bookmarks). See [issue #1](https://github.com/boozedog/x-mcp/issues/1).

## Why this exists

Agents re-ask the same X questions. User-context rate limits are the scarce resource. Pay for a tweet once, keep it locally, and answer later from SQLite.

Bookmarks are a drip. A cautious first-page poller fills the library in the background. There is no bookmark firehose; “as they come in” means every few minutes, not instantly.

## Non-goals (v1)

- No client secret, no agenix, no LiteLLM-held X tokens
- No MCP OAuth / DCR (X does not offer DCR; LiteLLM on the same host uses loopback)
- No Docker / OCI image
- No write tools (post, like, follow, delete)
- No media blob archive
- No Account Activity webhooks

## Runtime sketch

```
Laptop browser  --PKCE loopback-->  x-mcp login
                                      |
                                      v
                               $STATE_DIR/auth.json
                               $STATE_DIR/cache.sqlite

LiteLLM (same host)                    laptop / other tailnet
 http://host.docker.internal:8788/mcp    https://<serve-host>/mcp
                \                        /
                 v                      v
            systemd x-mcp  (Deno run --cached-only, 127.0.0.1:8788)
              /mcp + /health + in-process bookmark poller
                        |
                        v
                   api.x.com
```

Same-host Tailscale Serve hairpin does not work. LiteLLM must not use the MagicDNS Serve URL.

## Commands

```sh
x-mcp login     # one-shot PKCE; write auth.json
x-mcp serve     # HTTP MCP + bookmark poller
x-mcp refresh   # token health / force refresh (no secret values printed)
```

### CLI flags

- `--state-dir <dir>` (default `$XDG_STATE_HOME/x-mcp` or `~/.local/state/x-mcp`)
- `--client-id <id>` (or `X_CLIENT_ID`)
- `--port <port>` (default `8788`)
- `--poll-interval <sec>` (default `180`)
- `--login-port <port>` (default `8789`)
- `--log-level <debug|info|warn|error>` (default `info`; or `X_MCP_LOG_LEVEL`)
- `--backfill` — deep backfill at startup: page all the way back past overlap to
  reach older bookmarks the steady-state poller would never fetch
- `--backfill-pages <n>` (default `50`) — max pages for a `--backfill` run

## Login

`x-mcp login` runs a one-shot PKCE flow against a **public** X OAuth2 client
(`client_id` only, no secret, scope `tweet.read users.read bookmark.read offline.access`):

1. Provide the client id via `--client-id` or `X_CLIENT_ID`.
2. The tool prints an authorize URL, binds `http://127.0.0.1:<login-port>/callback`, and waits.
3. Open the URL in **your own browser** (or `ssh -L` to the host loopback). Never
   run the callback inside a container / `docker exec`.
4. On exchange it writes `$STATE_DIR/auth.json` (mode `0600`).

## Serve

`x-mcp serve` listens on `127.0.0.1:8788` by default:

- `GET /` — token-free HTML status screen (desktop + mobile, auto-refreshes)
- `POST /mcp` and `POST /mcp/` — Streamable HTTP MCP (`tools/list`, `tools/call`)
- `GET /health` — token-free JSON status (auth presence, sqlite counts, last poll,
  rate-limit remaining/reset)

It starts an in-process bookmark poller (`GET /2/users/{id}/bookmarks`, default
folder only, no folder endpoints) sharing one refresh mutex and one rate-limit
gate with the MCP tools.

### Status screen

`GET /` serves a dependency-free HTML page (inline CSS/JS, no frontend
dependency) that renders the same token-free health data as `/health` and
auto-refreshes every 15s. It is responsive for desktop and mobile. No access
tokens, refresh tokens, or `auth.json` contents are ever exposed on the page.

`serve` logs to stderr (token-free): HTTP requests, MCP tool calls, poller ticks,
and token refreshes (structure only — never the tokens). Set `--log-level debug`
for per-request `/health` lines.

By default the poller only watches the **newest** page (steady state). If you have
older bookmarks that predate the initial backfill, run once with `--backfill` to
page all the way back and fill the corpus:

```sh
x-mcp serve --backfill
```

The poller requests a curated set of `tweet.fields` / `user.fields` (created_at,
public_metrics, entities, author expansions, etc.) so the local corpus is rich.
It uses `max_results=50` for reliable pagination (X Staff workaround: `100` can
stop pagination early and drop `next_token`). `list_bookmarks` can sort by
`created` (the tweet's posting date) or `first_seen` (when x-mcp first saw it).

## MCP tools (v1)

| Tool | Behavior |
| --- | --- |
| `get_me` | Authenticated user; caches the user row |
| `get_user` | By `id` or `username`; sqlite-first unless `fresh: true` |
| `get_post` | By `id`; sqlite-first unless `fresh: true`; tombstones X-404s |
| `list_bookmarks` | **SQL** over `bookmarks` ⨝ `posts`; no X call. `sort` = `created` (tweet date) or `first_seen` (default) |
| `refresh_bookmarks` | Run one poller tick now |

All tool argument schemas are **Effect v4** schemas exposed to the MCP SDK via
`Schema.toStandardSchemaV1` + `Schema.toStandardJSONSchemaV1` (see `src/mcp-schema.ts`).

## NixOS module

The flake ships `nixosModules.default` (`services.x-mcp`):

```nix
{
  services.x-mcp = {
    enable = true;
    clientId = "your-public-x-client-id"; # not a secret
    port = 8788;
    pollInterval = 180;
  };
}
```

It runs the packaged `x-mcp serve --state-dir /var/lib/x-mcp` as a hardened
systemd unit (`DynamicUser`, `StateDirectory=0700`, `ProtectSystem=strict`).
The package is built from a Nix-store path using `deno run --cached-only` with a
pre-populated dependency cache.

To point LiteLLM at it (same host), use the loopback address:

```yaml
mcp_servers:
  x:
    url: http://host.docker.internal:8788/mcp
    authType: "none"
```

Do **not** use the MagicDNS Tailscale Serve URL from the same host — the Serve
hairpin does not work.

## Development

```sh
deno task check   # typecheck src/main.ts
deno task test    # unit tests (auth store, 429/stale path, tools/list)
nix build .#x-mcp # build the Nix package
```

## Stack

| Piece | Choice |
| --- | --- |
| Language | TypeScript on Deno |
| MCP | `@modelcontextprotocol/server` v2, `createMcpHandler`, Streamable HTTP |
| X | `@xdevplatform/xdk` OAuth2 public client + `Client` |
| Store | Deno `node:sqlite`, WAL, entity tables + bookmark edges |
| Ship | `deno run --cached-only` from a Nix-store path (`packages.x-mcp`, `nixosModules.default`) |

Keep `legacy: 'stateless'` so LiteLLM’s current MCP protocol (2025-11-25) still works.

## License

TBD. Do not commit `auth.json`, `cache.sqlite`, or any token file.
