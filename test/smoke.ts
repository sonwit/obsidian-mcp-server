/**
 * Smoke test against a running server.
 *   MCP_URL=http://127.0.0.1:3333/mcp MCP_TOKEN=... npm run smoke
 * Writes only inside "_smoketest/" in the vault. Delete that folder in Obsidian afterwards.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3333/mcp");
const token = process.env.MCP_TOKEN ?? "";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
}

async function connect(headers: Record<string, string>, target = url): Promise<Client> {
  const client = new Client({ name: "smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers } }));
  return client;
}

function text(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  return r.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: text(result) };
}

// Auth
try {
  await connect({ Authorization: "Bearer wrong-token-wrong-token-wrong-token" });
  check("rejects wrong token", false, "connected without a valid token");
} catch {
  check("rejects wrong token", true);
}

const pathUrl = new URL(url.href.replace(/\/mcp\/?$/, `/mcp/${token}`));
try {
  await connect({}, pathUrl);
  check("rejects token in path", false, "connected with the token in the URL");
} catch {
  check("rejects token in path", true);
}

const client = await connect({ Authorization: `Bearer ${token}` });
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("lists 7 tools", tools.length === 7, tools.join(", "));

const dir = `_smoketest/${Date.now()}`;
const note = `${dir}/Weekly plan æøå.md`;
const initial = "---\nweek: 1\n---\n# Weekly plan\n\n## Tasks\n- [ ] First\n- [ ] Second\n\n## Notes\nStart.\n";

let r = await call(client, "create_note", { path: note, content: initial });
check("create_note", !r.isError, r.text);
r = await call(client, "create_note", { path: note, content: "x" });
check("create_note refuses existing", r.isError);

r = await call(client, "edit_note", { path: note, old_text: "- [ ] First", new_text: "- [x] First" });
check("edit_note ticks checkbox", !r.isError, r.text);
r = await call(client, "edit_note", { path: note, old_text: "- [", new_text: "*" });
check("edit_note refuses ambiguous match", r.isError && r.text.includes("2 times"), r.text);

r = await call(client, "append_to_note", { path: note, text: "- [ ] Third", heading: "Tasks" });
check("append_to_note under heading", !r.isError, r.text);
r = await call(client, "append_to_note", { path: note, text: "Last line." });
check("append_to_note at end", !r.isError, r.text);

r = await call(client, "read_note", { path: note.normalize("NFD") });
const content = r.text.split("\n---\n").slice(1).join("\n---\n");
check("read_note (decomposed æøå in path)", !r.isError, r.text);
check(
  "content is as expected",
  content.includes("- [x] First\n- [ ] Second\n- [ ] Third\n\n## Notes\nStart.\nLast line.\n"),
  content,
);

const version = r.text.match(/^version: (\w+)$/m)?.[1] ?? "";
r = await call(client, "replace_note", { path: note, content: "# New\n", expected_version: "000000000000" });
check("replace_note refuses stale version", r.isError);
r = await call(client, "replace_note", { path: note, content: content + "\nReplaced.\n", expected_version: version });
check("replace_note with current version", !r.isError, r.text);

r = await call(client, "search_notes", { query: "THIRD", folder: dir });
check("search_notes case-insensitive", !r.isError && r.text.includes(":9:"), r.text);
r = await call(client, "list_notes", { folder: dir });
check("list_notes", !r.isError && r.text.includes("Weekly plan æøå.md"), r.text);

// Guardrails
for (const [label, args] of [
  ["blocks ..", { path: "../outside.md", content: "x" }],
  ["blocks absolute path", { path: "/etc/passwd.md", content: "x" }],
  ["blocks .obsidian", { path: ".obsidian/app.md", content: "x" }],
  ["blocks non-markdown", { path: `${dir}/script.sh`, content: "x" }],
] as const) {
  r = await call(client, "create_note", args);
  check(label, r.isError, r.text);
}

const resource = await client.readResource({ uri: "vault://index" });
check("vault://index resource", JSON.stringify(resource).includes("Weekly plan"));

await client.close();
console.log(failures ? `\n${failures} failed` : "\nAll checks passed");
console.log(`Remove the test folder "_smoketest" in Obsidian when done.`);
process.exit(failures ? 1 : 0);
