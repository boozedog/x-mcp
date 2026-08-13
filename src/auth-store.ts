/**
 * Atomic persistence for X OAuth tokens in `$STATE_DIR/auth.json`.
 *
 * Security rules (issue #1):
 *   - state dir created `0700`, auth.json written `0600`
 *   - atomic write via temp file + rename
 *   - never log or return the token contents
 */

export interface Auth {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope: string;
  /** unix seconds */
  expires_at: number;
}

export function authPath(stateDir: string): string {
  return `${stateDir}/auth.json`;
}

export async function loadAuth(stateDir: string): Promise<Auth | null> {
  try {
    const raw = await Deno.readTextFile(authPath(stateDir));
    return JSON.parse(raw) as Auth;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export async function saveAuth(stateDir: string, auth: Auth): Promise<void> {
  await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${authPath(stateDir)}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  await Deno.rename(tmp, authPath(stateDir));
  await Deno.chmod(authPath(stateDir), 0o600);
}

/** Public, token-free summary for `x-mcp refresh` / logging. */
export function publicAuth(auth: Auth | null): {
  has_access_token: boolean;
  has_refresh_token: boolean;
  expires_at_type: string;
  scope: string;
} {
  return {
    has_access_token: !!auth?.access_token,
    has_refresh_token: !!auth?.refresh_token,
    expires_at_type: typeof auth?.expires_at,
    scope: auth?.scope ?? "",
  };
}

