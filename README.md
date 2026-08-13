# x-mcp

Personal [MCP](https://modelcontextprotocol.io) server for the [X API](https://docs.x.com) (Twitter).

It is a long-running Deno process that:

- speaks official MCP TypeScript SDK **v2** over Streamable HTTP
- talks to X through the official TypeScript [XDK](https://github.com/xdevplatform/xdk-typescript) (`@xdevplatform/xdk`)
- uses a **public** OAuth 2.0 client (PKCE + `offline.access`, no client secret)
- persists every retrieved post, user, and bookmark edge in local SQLite
- polls bookmarks 24×7 so the local corpus grows while you are not chatting

Intended to sit next to [LiteLLM](https://docs.litellm.ai/docs/mcp) on a NixOS host. The app lives in this repo. Fleet wiring (systemd enable, Tailscale Serve, LiteLLM `mcp_servers`) stays in `nixos-infra`.

Status: design only. See [issue #1](https://github.com/boozedog/x-mcp/issues/1) for the implementation guide.

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
            systemd x-mcp  (Deno binary, 127.0.0.1:8788)
              /mcp + /health + in-process bookmark poller
                        |
                        v
                   api.x.com
```

Same-host Tailscale Serve hairpin does not work. LiteLLM must not use the MagicDNS Serve URL.

## Planned commands

```sh
x-mcp login     # one-shot PKCE; write auth.json
x-mcp serve     # HTTP MCP + bookmark poller
x-mcp refresh   # token health / force refresh (no secret values printed)
```

## Planned stack

| Piece | Choice |
| --- | --- |
| Language | TypeScript on Deno |
| MCP | `@modelcontextprotocol/server` v2, `createMcpHandler`, Streamable HTTP |
| X | `@xdevplatform/xdk` OAuth2 public client + `Client` |
| Store | Deno `node:sqlite`, WAL, entity tables + bookmark edges |
| Ship | `deno compile` via a Nix flake (`packages.x-mcp`, `nixosModules.default`) |

Keep `legacy: 'stateless'` so LiteLLM’s current MCP protocol (2025-11-25) still works.

## License

TBD. Do not commit `auth.json`, `cache.sqlite`, or any token file.
