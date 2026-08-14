import { assertEquals } from "@std/assert";
import { parseArgs } from "./main.ts";

Deno.test("parseArgs: default host is loopback", () => {
  const opts = parseArgs(["serve"], {});
  assertEquals(opts.host, "127.0.0.1");
});

Deno.test("parseArgs: --host overrides the loopback default", () => {
  const opts = parseArgs(["serve", "--host", "0.0.0.0"], {});
  assertEquals(opts.host, "0.0.0.0");
});

Deno.test("parseArgs: X_MCP_HOST env is honored when no flag is given", () => {
  const opts = parseArgs(["serve"], { X_MCP_HOST: "172.17.0.1" });
  assertEquals(opts.host, "172.17.0.1");
});

Deno.test("parseArgs: --host flag wins over X_MCP_HOST env", () => {
  const opts = parseArgs(["serve", "--host", "10.0.0.5"], { X_MCP_HOST: "172.17.0.1" });
  assertEquals(opts.host, "10.0.0.5");
});

Deno.test("parseArgs: non-loopback host is preserved verbatim", () => {
  const opts = parseArgs(["serve", "--host", "192.168.1.50"], {});
  assertEquals(opts.host, "192.168.1.50");
});
