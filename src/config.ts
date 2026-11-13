import { readFileSync, realpathSync, statSync } from "node:fs";

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

/**
 * Returns the token from MCP_TOKEN, or from the file named by MCP_TOKEN_FILE (e.g. a Docker secret in /run/secrets).
 * Setting both is ambiguous and rejected. Error messages never include the file's contents.
 */
export function readToken(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string {
  const file = env.MCP_TOKEN_FILE?.trim();
  if (!file) return env.MCP_TOKEN ?? "";
  if (env.MCP_TOKEN) throw new Error("Both MCP_TOKEN and MCP_TOKEN_FILE are set. Use only one of them.");
  let content: string;
  try {
    content = readFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`Could not read MCP_TOKEN_FILE (${file}): ${code}`);
  }
  return content.replace(/\r?\n$/, "");
}

export function validateToken(token: string): string | undefined {
  if (token.length < 32) return "MCP_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32";
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return "MCP_TOKEN may only contain A-Z, a-z, 0-9, _ and -.";
  return undefined;
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

  let token: string;
  try {
    token = readToken(env);
  } catch (err) {
    fail((err as Error).message);
  }
  const tokenError = validateToken(token);
  if (tokenError) fail(tokenError);

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
