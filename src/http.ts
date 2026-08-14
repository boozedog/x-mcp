/**
 * HTTP route dispatch for `x-mcp serve` (issue #1).
 *
 * Routes:
 *   GET  /            token-free HTML status screen (see status.ts)
 *   GET  /health      token-free JSON health
 *   POST /mcp, /mcp/  Streamable HTTP MCP (tools/list, tools/call)
 *
 * Extracted from main.ts so the routing is unit-testable without booting the
 * whole server. `/mcp` and `/mcp/` are treated identically; no absolute
 * redirects are emitted.
 */
import type { Logger } from "./logger.ts";
import { renderStatusPage, type HealthData } from "./status.ts";

/** Minimal structural type for the MCP handler's fetch method. */
export interface McpHandlerLike {
  fetch(req: Request): Promise<Response>;
}

export interface HttpDeps {
  log: Logger;
  mcpHandler: McpHandlerLike | null;
  /** Build a fresh token-free health snapshot on each request. */
  getHealth: () => HealthData;
}

/** Build the request handler for `Deno.serve`. */
export function buildHttpHandler(deps: HttpDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") {
      deps.log.debug(`http ${req.method} ${url.pathname}`);
      return Response.json(deps.getHealth());
    }
    if (url.pathname === "/" && req.method === "GET") {
      deps.log.debug(`http ${req.method} ${url.pathname}`);
      return new Response(renderStatusPage(deps.getHealth()), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if ((url.pathname === "/mcp" || url.pathname === "/mcp/") && deps.mcpHandler) {
      deps.log.info(`http ${req.method} ${url.pathname}`);
      return deps.mcpHandler.fetch(req);
    }
    deps.log.warn(`http ${req.method} ${url.pathname} -> 404`);
    return new Response("not found", { status: 404 });
  };
}
