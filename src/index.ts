import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { Vault } from "./vault.ts";

const config = loadConfig();
const vault = new Vault(config.vaultRoot, config.maxWriteBytes);
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
// Log every request (never the token, never note content) so connection problems are visible.
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const path = req.originalUrl.replace(/^\/mcp\/[^/?]+/, "/mcp/<token>");
    const auth = req.get("authorization") ? "bearer" : "none";
    const rpc = typeof req.body?.method === "string" ? ` rpc=${req.body.method}` : "";
    console.log(
      `[http] ${req.method} ${path} -> ${res.statusCode} ${Date.now() - started}ms auth=${auth}${rpc} accept="${req.get("accept") ?? ""}" ua="${req.get("user-agent") ?? ""}"`,
    );
  });
  next();
});

function sameToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authenticate with the header "Authorization: Bearer <token>" on /mcp.
 * The token is never accepted in the URL, where it could end up in logs and history.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

  if (sameToken(bearer)) return next();

  console.warn(`[auth] rejected ${req.method} from ${req.ip}`);
  // Slow down guessing a little; the token itself is what actually protects the server.
  setTimeout(() => {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }, 500);
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  // Stateless: a fresh server and transport per request. Simple, and survives restarts.
  const server = createServer(vault);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server, POST only)." },
    id: null,
  });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Authenticate before parsing, so anonymous requests cannot make the server read a body.
app.post("/mcp", requireAuth, express.json({ limit: "2mb" }), handleMcp);
app.get("/mcp", requireAuth, methodNotAllowed);
app.delete("/mcp", requireAuth, methodNotAllowed);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(config.port, config.host, () => {
  console.log(`[vault-mcp] serving ${config.vaultRoot} on http://${config.host}:${config.port}/mcp`);
});
