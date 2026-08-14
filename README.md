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
- `--host <address>` (default `127.0.0.1`; or `X_MCP_HOST`) — address `serve` binds to
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

`x-mcp serve` listens on `127.0.0.1:8788` by default. Pass `--host <address>`
(or set `X_MCP_HOST`) to bind to a different address, e.g. `0.0.0.0` or a
specific Docker bridge address so a containerized LiteLLM can reach it via
`host.docker.internal`. Loopback stays the default; the fleet restricts any
non-loopback bind with host firewall policy rather than public ingress or
Tailscale Serve.

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
    host = "127.0.0.1"; # bind address; e.g. "0.0.0.0" for Docker-hosted LiteLLM
    port = 8788;
    pollInterval = 180;
  };
}
```

It runs the packaged `x-mcp serve --state-dir /var/lib/x-mcp` as a hardened
systemd unit (`DynamicUser`, `StateDirectory=0700`, `ProtectSystem=strict`).
The package is built from a Nix-store path using `deno run --cached-only` with a
pre-populated dependency cache.

### Deno cache under the hardened unit

Deno needs a **writable** directory for its runtime cache (`DENO_DIR`). Under
`DynamicUser` + `ProtectSystem=strict` the per-user `$HOME/.cache` path is not
writable, so the module declares a systemd-managed cache:

```nix
serviceConfig.CacheDirectory = "x-mcp";      # -> /var/cache/x-mcp
serviceConfig.CacheDirectoryMode = "0700";
```

systemd creates `/var/cache/x-mcp` (owned by the service's dynamic user), makes
it writable even under `ProtectSystem=strict`, and exports `$CACHE_DIRECTORY`
for the process. The packaged wrapper prefers `$CACHE_DIRECTORY` when set and
falls back to `$XDG_CACHE_HOME/x-mcp` / `$HOME/.cache/x-mcp` for local,
non-systemd use. `auth.json` and `cache.sqlite` stay under `stateDir`
(`/var/lib/x-mcp`, `0700`) as before.

### Login as the service identity

The service runs as a **named dynamic user** `x-mcp` (`User = "x-mcp"` +
`DynamicUser = true`). With `DynamicUser`, systemd stores `stateDir` under
`/var/lib/private/x-mcp` (bind-mounted to `/var/lib/x-mcp` only inside the
service's namespace). To write `auth.json` there, run the login as a transient
unit that requests the **same dynamic user name** — systemd keys dynamic users by
name, so `User=x-mcp` + `DynamicUser=yes` shares the service's exact UID:

```sh
# Path to the packaged binary (bare `x-mcp` is not on PATH).
BIN=$(systemctl cat x-mcp | awk '/^ExecStart=/ { sub(/^ExecStart=/, ""); print $1; exit }')

# Run the one-shot PKCE login as the service's dynamic user, in the same sandbox.
sudo systemd-run --pty --wait \
  --property=DynamicUser=yes \
  --property=User=x-mcp \
  --property=StateDirectory=x-mcp \
  --property=CacheDirectory=x-mcp \
  --property=ProtectSystem=strict \
  --property=ProtectHome=true \
  -- "$BIN" login --state-dir /var/lib/x-mcp --client-id <your-public-client-id>
```

It prints the authorize URL and binds `http://127.0.0.1:8789/callback`.

> Why `User=x-mcp` + `DynamicUser=yes`? systemd's `dynamic_user_acquire()` keys
> dynamic users by **name**, so any unit requesting the same name shares the
> service's UID and lock. Two failure modes to avoid: a bare `--uid=<numeric>`
> does not share that object (systemd treats it as a plain UID and migrates the
> private state dir to the public path), and a bare `DynamicUser=yes` without
> `User=x-mcp` allocates a *different* dynamic user that chowns the state dir away
> from the service. `User=x-mcp` + `DynamicUser=yes` is a named dynamic user, not
> a static user, so it does not weaken `DynamicUser`.

#### SSH loopback callback (remote host)

On a remote NixOS host, forward the callback port to your laptop so the browser
redirect lands on the host's loopback:

```sh
# From your laptop, before running the login on the host:
ssh -L 8789:127.0.0.1:8789 user@host
```

Then run the `systemd-run` login command above on the host. Open the printed
authorize URL in your **local** browser; X redirects to
`http://127.0.0.1:8789/callback`, which SSH forwards to the host's loopback where
the login process is listening. On success it writes `auth.json` to
`/var/lib/x-mcp` and the service picks it up on its next restart. If the login
port differs from the default `8789`, pass `--login-port <port>` to `x-mcp login`
and forward that same port with `ssh -L <port>:127.0.0.1:<port> user@host`.

To point LiteLLM at it (same host), use the loopback address. For a Docker-hosted
LiteLLM to reach the host service via `host.docker.internal`, set
`services.x-mcp.host` to a non-loopback address (`0.0.0.0` or a specific Docker
bridge address) and restrict it with host firewall policy:

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
