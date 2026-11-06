import { realpathSync, statSync } from "node:fs";

export interface Config {
  vaultRoot: string;
  token: string;
  host: string;
  port: number;
  maxWriteBytes: number;
}

function fail(message: string): never {
  console.error(`[config] ${message}`);
  process.exit(1);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawRoot = env.VAULT_ROOT;
  if (!rawRoot) fail("VAULT_ROOT is missing (path to the vault folder).");

  let vaultRoot: string;
  try {
    vaultRoot = realpathSync(rawRoot);
    if (!statSync(vaultRoot).isDirectory()) fail(`VAULT_ROOT is not a folder: ${rawRoot}`);
  } catch {
    fail(`VAULT_ROOT does not exist: ${rawRoot}`);
  }

  const token = env.MCP_TOKEN ?? "";
  if (token.length < 32) {
    fail("MCP_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    fail("MCP_TOKEN may only contain A-Z, a-z, 0-9, _ and -.");
  }

  const port = Number(env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid PORT: ${env.PORT}`);

  return {
    vaultRoot,
    token,
    // Bind only to loopback by default; put a reverse proxy in front to expose it.
    host: env.HOST ?? "127.0.0.1",
    port,
    maxWriteBytes: Number(env.MAX_WRITE_BYTES ?? 1_000_000),
  };
}
