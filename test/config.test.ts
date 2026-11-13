import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readToken, validateToken } from "../src/config.ts";

const TOKEN = "a".repeat(64);

function tokenFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "vault-mcp-")), "token");
  writeFileSync(file, content);
  return file;
}

test("MCP_TOKEN works as before", () => {
  assert.equal(readToken({ MCP_TOKEN: TOKEN }), TOKEN);
});

test("MCP_TOKEN_FILE is read and the trailing newline removed", () => {
  assert.equal(readToken({ MCP_TOKEN_FILE: tokenFile(`${TOKEN}\n`) }), TOKEN);
  assert.equal(readToken({ MCP_TOKEN_FILE: tokenFile(`${TOKEN}\r\n`) }), TOKEN);
});

test("setting both MCP_TOKEN and MCP_TOKEN_FILE is rejected", () => {
  assert.throws(() => readToken({ MCP_TOKEN: TOKEN, MCP_TOKEN_FILE: tokenFile(TOKEN) }), /Both MCP_TOKEN and MCP_TOKEN_FILE/);
});

test("a missing file gives a clear error", () => {
  assert.throws(() => readToken({ MCP_TOKEN_FILE: "/does/not/exist" }), /MCP_TOKEN_FILE \(\/does\/not\/exist\): ENOENT/);
});

test("error messages never contain the file's contents", () => {
  const readFile = () => {
    throw Object.assign(new Error(`secret ${TOKEN}`), { code: "EACCES" });
  };
  assert.throws(
    () => readToken({ MCP_TOKEN_FILE: "/run/secrets/x" }, readFile),
    (err: Error) => err.message.endsWith("EACCES") && !err.message.includes(TOKEN),
  );
});

test("the token from a file is validated like MCP_TOKEN", () => {
  assert.match(validateToken(readToken({ MCP_TOKEN_FILE: tokenFile("short\n") })) ?? "", /at least 32/);
  assert.match(validateToken(`${TOKEN} `) ?? "", /may only contain/);
  assert.equal(validateToken(TOKEN), undefined);
});
