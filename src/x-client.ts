/**
 * XDK-backed client with one shared refresh mutex and one rate-limit gate.
 *
 * Both MCP tools and the bookmark poller go through this single XClient, so a
 * token refresh or a 429 backoff is shared process-wide. After every refresh the
 * rotated tokens are persisted to auth.json (issue #1: "persist after every refresh").
 */
import { Client, OAuth2, ApiError } from "@xdevplatform/xdk";
import type { Auth } from "./auth-store.ts";
import { Logger } from "./logger.ts";

export class RateLimitError extends Error {
  readonly reset: number; // unix seconds
  constructor(reset: number) {
    super("X API rate limit exceeded");
    this.name = "RateLimitError";
    this.reset = reset;
  }
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export interface RateState {
  remaining: number | null;
  reset: number | null; // unix seconds
}

interface SaveFn {
  (auth: Auth): Promise<void>;
}

export class XClient {
  private auth: Auth;
  private readonly save: SaveFn;
  private readonly clientId: string;
  private readonly logger: Logger;
  private client: Client;
  /** Refresh mutex: serializes refreshToken so concurrent callers share one refresh. */
  private refreshQueue: Promise<void> = Promise.resolve();
  /** Rate-limit gate. */
  private gateRemaining: number | null = null;
  private gateReset: number | null = null; // unix seconds

  constructor(auth: Auth, clientId: string, save: SaveFn, logger?: Logger) {
    this.auth = auth;
    this.clientId = clientId;
    this.save = save;
    this.logger = logger ?? new Logger();
    this.client = new Client({ accessToken: auth.access_token });
  }

  /** Shared, mutex-guarded refresh. force bypasses the expiry check (used by `refresh` command). */
  async refreshIfNeeded(force = false): Promise<void> {
    const run = async (): Promise<void> => {
      const now = Date.now() / 1000;
      if (!force && this.auth.expires_at - now > 60) return;
      const oauth = new OAuth2({ clientId: this.clientId, redirectUri: "" });
      oauth.setToken({
        access_token: this.auth.access_token,
        token_type: this.auth.token_type,
        expires_in: Math.max(1, Math.floor(this.auth.expires_at - now)),
        refresh_token: this.auth.refresh_token,
        scope: this.auth.scope,
      });
      const token = await oauth.refreshToken();
      const nextExpiresAt = Math.floor(Date.now() / 1000) + Number(token.expires_in ?? 3600);
      this.logger.info(
        `token refreshed; expires in ${Number(token.expires_in ?? 3600)}s, ` +
          `has_refresh_token=${!!token.refresh_token}`,
      );
      this.auth = {
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? this.auth.refresh_token,
        token_type: token.token_type ?? this.auth.token_type,
        scope: token.scope ?? this.auth.scope,
        expires_at: nextExpiresAt,
      };
      // Rebuild client with the new access token.
      this.client = new Client({ accessToken: this.auth.access_token });
      // Persist rotation after every refresh.
      await this.save(this.auth);
    };

    const prior = this.refreshQueue;
    let release!: () => void;
    this.refreshQueue = new Promise<void>((r) => (release = r));
    await prior;
    try {
      await run();
    } finally {
      release();
    }
  }

  get rate(): RateState {
    return { remaining: this.gateRemaining, reset: this.gateReset };
  }

  /** Token-free live auth summary (for /health). */
  authSummary(): { expires_at: number; has_refresh_token: boolean } {
    return {
      expires_at: this.auth.expires_at,
      has_refresh_token: !!this.auth.refresh_token,
    };
  }

  /**
   * Run a raw XDK call with shared refresh + rate-limit gating.
   * `call` receives the current Client and returns a raw `Response`.
   */
  private async gate<T>(call: (client: Client) => Promise<Response>): Promise<T> {
    await this.refreshIfNeeded();
    if (this.gateRemaining !== null && this.gateRemaining <= 0 && this.gateReset !== null) {
      const now = Math.floor(Date.now() / 1000);
      if (this.gateReset > now) throw new RateLimitError(this.gateReset);
    }

    let res: Response;
    try {
      res = await call(this.client);
    } catch (err) {
      // XDK throws ApiError for non-2xx before returning a raw Response.
      if (err instanceof ApiError) {
        this.updateGateFromHeaders(err.headers);
        if (err.status === 429) {
          const reset = Number(err.headers.get("x-rate-limit-reset") ?? 0);
          throw new RateLimitError(reset);
        }
        if (err.status === 404) throw new NotFoundError(err.statusText || "not found");
        throw new Error(`X returned ${err.status}: ${err.message}`);
      }
      throw err;
    }
    this.updateGate(res);
    return res as unknown as T;
  }

  private updateGate(res: Response): void {
    this.updateGateFromHeaders(res.headers);
  }

  private updateGateFromHeaders(headers: Headers): void {
    const remaining = headers.get("x-rate-limit-remaining");
    const reset = headers.get("x-rate-limit-reset");
    if (remaining !== null) this.gateRemaining = Number(remaining);
    if (reset !== null) this.gateReset = Number(reset);
  }

  /** Parse a raw response body; throw typed errors for 404 / 429 / other. */
  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0);
      throw new RateLimitError(reset);
    }
    if (res.status === 404) throw new NotFoundError(res.url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`X returned ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async getMe(): Promise<GetMeResponse> {
    return this.gate((c) =>
      c.users.getMe({ requestOptions: { raw: true } })
    ).then((r) => this.parse(r as unknown as Response));
  }

  async getUserById(id: string): Promise<GetUserResponse> {
    return this.gate((c) => c.users.getById(id, { requestOptions: { raw: true } })).then(
      (r) => this.parse(r as unknown as Response),
    );
  }

  async getUserByUsername(username: string): Promise<GetUserResponse> {
    return this.gate((c) =>
      c.users.getByUsername(username, { requestOptions: { raw: true } })
    ).then((r) => this.parse(r as unknown as Response));
  }

  async getPost(id: string): Promise<GetPostResponse> {
    return this.gate((c) => c.posts.getById(id, { requestOptions: { raw: true } })).then(
      (r) => this.parse(r as unknown as Response),
    );
  }

  /** Fetch one bookmark page (default folder only). No folder endpoints. */
  async getBookmarksPage(
    userId: string,
    paginationToken?: string,
  ): Promise<GetBookmarksPage> {
    return this.gate((c) =>
      c.users.getBookmarks(userId, {
        // Smaller pages: more reliable pagination (the max_results=100 early-stop
        // bug) and smaller payloads now that we request rich fields.
        maxResults: 50,
        paginationToken,
        postFields: [...POST_FIELDS],
        userFields: [...USER_FIELDS],
        expansions: [...POST_EXPANSIONS],
        requestOptions: { raw: true },
      })
    ).then((r) => this.parse(r as unknown as Response));
  }
}

export interface GetMeResponse {
  data?: XUser;
  includes?: { users?: XUser[]; posts?: XPost[] };
}

export interface GetUserResponse {
  data?: XUser;
  includes?: { users?: XUser[]; posts?: XPost[] };
}

export interface GetPostResponse {
  data?: XPost;
  includes?: { users?: XUser[]; posts?: XPost[] };
}

export interface GetBookmarksPage {
  data?: XPost[];
  includes?: { users?: XUser[]; posts?: XPost[] };
  meta?: { next_token?: string; nextToken?: string; result_count?: number };
}

export interface XUser {
  id: string;
  username?: string;
  name?: string;
  [k: string]: unknown;
}

export interface XPost {
  id: string;
  text?: string;
  [k: string]: unknown;
}

/**
 * Curated tweet.fields for the bookmark poller. Skips private/elevated-access
 * fields (non_public_metrics, organic_metrics, promoted_metrics) and niche ones
 * (note_post, article, media_metadata, scopes, suggested_source_links*).
 */
export const POST_FIELDS = [
  "created_at",
  "public_metrics",
  "entities",
  "conversation_id",
  "attachments",
  "lang",
  "source",
  "possibly_sensitive",
  "geo",
  "context_annotations",
  "reply_settings",
  "withheld",
] as const;

/** Curated user.fields for the bookmark poller (author expansions). */
export const USER_FIELDS = [
  "created_at",
  "description",
  "public_metrics",
  "profile_image_url",
  "profile_banner_url",
  "location",
  "url",
  "verified",
  "protected",
  "entities",
] as const;

/** Expansions so authors come back in the same response (no extra calls). */
export const POST_EXPANSIONS = ["author_id"] as const;
