/**
 * One-shot PKCE login (issue #1).
 *
 * Binds a loopback callback on the login port, prints the authorize URL for the
 * operator to open in their own browser, exchanges the code, and writes auth.json.
 *
 * Login MUST NOT run as a child of `serve`. Operators use a laptop browser or
 * `ssh -L` to the host loopback (never `docker exec` a callback).
 */
import { OAuth2, generateCodeVerifier } from "@xdevplatform/xdk";
import { saveAuth, type Auth } from "./auth-store.ts";

const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

export interface LoginResult {
  ok: boolean;
  detail?: string;
}

export async function runLogin(
  stateDir: string,
  clientId: string,
  port: number,
  redirectPath = "/callback",
): Promise<LoginResult> {
  if (!clientId) {
    return { ok: false, detail: "X_CLIENT_ID is required for login" };
  }

  const redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
  const verifier = generateCodeVerifier();
  const oauth = new OAuth2({
    clientId,
    redirectUri,
    scope: SCOPES,
  });
  await oauth.setPkceParameters(verifier);

  const state = crypto.randomUUID();
  const authUrl = await oauth.getAuthorizationUrl(state);

  // Bind a loopback callback. Deno.serve keeps the process alive until we exit.
  let exchange!: (code: string) => void;
  const codePromise = new Promise<string>((r) => (exchange = r));
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, signal: ac.signal },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname !== redirectPath) return new Response("not found", { status: 404 });
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (!code) {
        return new Response("missing code", { status: 400 });
      }
      if (gotState !== state) {
        return new Response("state mismatch", { status: 400 });
      }
      exchange(code);
      return new Response("login complete, you may close this tab", { status: 200 });
    },
  );

  console.log(`\nOpen this URL in your browser to authorize x-mcp:\n\n  ${authUrl}\n`);
  console.log(`(Callback will be received on http://127.0.0.1:${port}${redirectPath})\n`);

  const code = await codePromise;
  let token;
  try {
    token = await oauth.exchangeCode(code, verifier);
  } catch (err) {
    ac.abort();
    await server.shutdown();
    return { ok: false, detail: err instanceof Error ? err.message : "exchange failed" };
  }

  const auth: Auth = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type ?? "Bearer",
    scope: token.scope ?? SCOPES.join(" "),
    expires_at: Math.floor(Date.now() / 1000) + Number(token.expires_in ?? 7200),
  };
  await saveAuth(stateDir, auth);

  ac.abort();
  await server.shutdown().catch(() => {});
  console.log("auth.json written (0600). Run `x-mcp serve`.");
  return { ok: true };
}
