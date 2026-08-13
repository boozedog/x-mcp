import { assertEquals, assertExists } from "@std/assert";
import { loadAuth, saveAuth, publicAuth, type Auth } from "./auth-store.ts";

Deno.test("auth store: save then load round-trips", async () => {
  const dir = await Deno.makeTempDir();
  const auth: Auth = {
    access_token: "at-secret",
    refresh_token: "rt-secret",
    token_type: "Bearer",
    scope: "tweet.read offline.access",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  await saveAuth(dir, auth);
  const loaded = await loadAuth(dir);
  assertEquals(loaded?.access_token, "at-secret");
  assertEquals(loaded?.refresh_token, "rt-secret");
});

Deno.test("auth store: file is 0600 and dir is 0700", async () => {
  const dir = await Deno.makeTempDir();
  const auth: Auth = {
    access_token: "at",
    token_type: "Bearer",
    scope: "offline.access",
    expires_at: 0,
  };
  await saveAuth(dir, auth);
  const dirMode = (await Deno.stat(dir)).mode! & 0o777;
  const fileMode = (await Deno.stat(`${dir}/auth.json`)).mode! & 0o777;
  assertEquals(dirMode, 0o700);
  assertEquals(fileMode, 0o600);
});

Deno.test("auth store: rotation overwrites, no stale temp files", async () => {
  const dir = await Deno.makeTempDir();
  const a: Auth = { access_token: "a1", refresh_token: "r1", token_type: "Bearer", scope: "s", expires_at: 1 };
  await saveAuth(dir, a);
  const b: Auth = { ...a, access_token: "a2", refresh_token: "r2" };
  await saveAuth(dir, b);
  const loaded = await loadAuth(dir);
  assertEquals(loaded?.access_token, "a2");
  assertEquals(loaded?.refresh_token, "r2");
  const entries = [...Deno.readDirSync(dir)].map((e) => e.name);
  assertEquals(entries.filter((n) => n.endsWith(".tmp")).length, 0);
});

Deno.test("auth store: missing file loads as null", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await loadAuth(dir), null);
});

Deno.test("publicAuth never includes tokens", async () => {
  const auth: Auth = {
    access_token: "SECRET_AT",
    refresh_token: "SECRET_RT",
    token_type: "Bearer",
    scope: "offline.access",
    expires_at: 123,
  };
  const p = publicAuth(auth);
  const s = JSON.stringify(p);
  assertExists(p.has_access_token);
  assertExists(p.has_refresh_token);
  if (s.includes("SECRET")) throw new Error("publicAuth leaked a token");
});
