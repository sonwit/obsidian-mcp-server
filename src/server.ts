import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Vault, VaultError, type Note } from "./vault.ts";

const INSTRUCTIONS = `
This server gives access to the user's Obsidian vault, synced across their devices.
Notes are Markdown files addressed by vault-relative paths like "Projects/Week 1.md".

How to work with it:
- Start a session by reading "About the vault.md" if it exists; it describes the structure and conventions.
- Read a note before changing it. Prefer edit_note (small, exact replacements) or append_to_note
  (add under a heading) over replace_note, so edits made on another device are not overwritten.
- Keep YAML frontmatter, wiki links ([[Note]]) and task checkboxes (- [ ] / - [x]) intact.
- Nothing can be deleted or moved through this server; ask the user to do that in Obsidian.
`.trim();

function noteText(note: Note, includeContent = true): string {
  const header = `path: ${note.path}\nversion: ${note.version}\nmodified: ${note.modified}\nsize: ${note.size}`;
  return includeContent ? `${header}\n---\n${note.content}` : header;
}

/** Wrap a handler so expected errors come back as readable tool errors the model can act on. */
function tool<A>(name: string, fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const text = await fn(args);
      console.log(`[tool] ${name} ok ${Date.now() - started}ms ${summarize(args)}`);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof VaultError ? err.message : `Unexpected error: ${(err as Error).message}`;
      console.log(`[tool] ${name} error ${summarize(args)}: ${message}`);
      if (!(err instanceof VaultError)) console.error(err);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

/** Log which note was touched, never its content. */
function summarize(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  return [a.path, a.folder, a.query].filter((v) => typeof v === "string").map((v) => JSON.stringify(v)).join(" ");
}

const pathParam = z
  .string()
  .min(1)
  .describe('Vault-relative path to a Markdown note, including ".md", e.g. "Projects/Week 1 - Setup.md".');

export function createServer(vault: Vault): McpServer {
  const server = new McpServer({ name: "obsidian-vault", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List Markdown notes and subfolders in the vault or in one folder. Use this to discover what exists before reading or creating notes.",
      inputSchema: {
        folder: z.string().optional().describe('Folder relative to the vault root. Omit for the whole vault.'),
        recursive: z.boolean().optional().describe("Include notes in subfolders. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool("list_notes", async ({ folder, recursive }: { folder?: string; recursive?: boolean }) => {
      const { notes, folders } = await vault.list(folder ?? "", recursive ?? true);
      const lines = [
        `folders: ${folders.length ? folders.join(", ") : "(none)"}`,
        `notes (${notes.length}):`,
        ...notes.map((n) => `- ${n.path}  (${n.size} B, modified ${n.modified})`),
      ];
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read the full content of one note. Returns a version hash that replace_note requires, so you can prove you saw the latest content.",
      inputSchema: { path: pathParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool("read_note", async ({ path }: { path: string }) => noteText(await vault.read(path))),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive text search across note names and contents. Returns matching lines with line numbers. Use short, distinctive terms.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for."),
        folder: z.string().optional().describe("Limit the search to this folder."),
        max_results: z.number().int().min(1).max(100).optional().describe("Default 20."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool("search_notes", async ({ query, folder, max_results }: { query: string; folder?: string; max_results?: number }) => {
      const hits = await vault.search(query, folder ?? "", max_results ?? 20);
      if (hits.length === 0) return `No matches for "${query}".`;
      return hits.map((h) => (h.line ? `${h.path}:${h.line}: ${h.text}` : `${h.path}: ${h.text}`)).join("\n");
    }),
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description:
        "Create a new note. Fails if the note already exists. Missing folders are created. Use Obsidian Markdown: frontmatter, [[wiki links]] and - [ ] tasks are fine.",
      inputSchema: {
        path: pathParam,
        content: z.string().describe("Full Markdown content of the new note."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    tool("create_note", async ({ path, content }: { path: string; content: string }) =>
      `Created.\n${noteText(await vault.create(path, content), false)}`,
    ),
  );

  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Replace one exact piece of text in a note with new text. old_text must occur exactly once; include surrounding lines to make it unique. Best tool for ticking a checkbox, fixing a line or rewriting a paragraph without touching the rest.",
      inputSchema: {
        path: pathParam,
        old_text: z.string().min(1).describe("Exact existing text, including whitespace and line breaks."),
        new_text: z.string().describe("Replacement text. Empty string removes old_text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    tool("edit_note", async ({ path, old_text, new_text }: { path: string; old_text: string; new_text: string }) =>
      `Edited.\n${noteText(await vault.edit(path, old_text, new_text), false)}`,
    ),
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append to note",
      description:
        "Add text to a note without rewriting it: at the end, or at the end of the section under a given heading. Use for logs, notes and new list items.",
      inputSchema: {
        path: pathParam,
        text: z.string().min(1).describe("Markdown to add."),
        heading: z
          .string()
          .optional()
          .describe('Heading text (with or without #) whose section the text goes at the end of, e.g. "Notes".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    tool("append_to_note", async ({ path, text, heading }: { path: string; text: string; heading?: string }) =>
      `Appended.\n${noteText(await vault.append(path, text, heading), false)}`,
    ),
  );

  server.registerTool(
    "replace_note",
    {
      title: "Replace note",
      description:
        "Overwrite a whole note. Requires the version from your latest read_note, and fails if the note changed since (for example edited on the phone). Prefer edit_note or append_to_note when possible.",
      inputSchema: {
        path: pathParam,
        content: z.string().describe("New full content."),
        expected_version: z.string().length(12).describe("The version value returned by read_note."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(
      "replace_note",
      async ({ path, content, expected_version }: { path: string; content: string; expected_version: string }) =>
        `Replaced.\n${noteText(await vault.replace(path, content, expected_version), false)}`,
    ),
  );

  server.registerTool(
    "recent_changes",
    {
      title: "Recent changes",
      description:
        "List notes changed in the last N days, newest first, with modification time. Use this to see what the user (or another agent) has worked on lately, for example before a weekly review, instead of listing and reading the whole vault. Changes from every synced device count.",
      inputSchema: {
        days: z.number().positive().max(365).optional().describe("How far back to look, in days. Fractions are fine (0.5 = 12 hours). Default 7."),
        folder: z.string().optional().describe("Limit to this folder. Omit for the whole vault."),
        max_results: z.number().int().min(1).max(200).optional().describe("Default 50."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(
      "recent_changes",
      async ({ days, folder, max_results }: { days?: number; folder?: string; max_results?: number }) => {
        const d = days ?? 7;
        const { notes, total } = await vault.recent(folder ?? "", new Date(Date.now() - d * 86_400_000), max_results ?? 50);
        if (total === 0) return `No notes changed in the last ${d} days${folder ? ` in "${folder}"` : ""}.`;
        const lines = [
          `${total} note(s) changed in the last ${d} days${notes.length < total ? `, showing the ${notes.length} newest` : ""}:`,
          ...notes.map((n) => `- ${n.path}  (modified ${n.modified})`),
        ];
        return lines.join("\n");
      },
    ),
  );

  server.registerTool(
    "week_progress",
    {
      title: "Task progress",
      description:
        'Count task checkboxes (- [ ] open, - [x] done) in every note in a folder, per note and per heading section, plus the note\'s frontmatter fields (such as status and deadline). Use this to answer "how far am I this week?" or to find what is left, without reading every note. Notes without tasks are left out. Read a note afterwards to see which tasks are open.',
      inputSchema: {
        folder: z.string().describe('Folder with the notes to count, e.g. "NDC AI/Plan".'),
        recursive: z.boolean().optional().describe("Include subfolders. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool("week_progress", async ({ folder, recursive }: { folder: string; recursive?: boolean }) => {
      const results = await vault.taskProgress(folder, recursive ?? true);
      if (results.length === 0) return `No tasks found in "${folder}".`;
      const pct = (done: number, total: number) => `${done}/${total} (${Math.round((100 * done) / total)}%)`;
      return results
        .map((r) => {
          const fm = Object.entries(r.frontmatter).map(([k, v]) => `${k}: ${v}`).join(", ");
          const sections = r.sections.map((s) => `  ${s.heading}: ${s.done}/${s.total}`);
          return [`${r.path}  ${pct(r.done, r.total)}${fm ? `  [${fm}]` : ""}`, ...sections].join("\n");
        })
        .join("\n\n");
    }),
  );

  server.registerTool(
    "archive_note",
    {
      title: "Archive note",
      description: "Moves a not to the archive folder. Use if the user asks for a note to be deleated. Archived notes are places in the archive in a folder named with the date it was archived. We keep the rest of the file-path so restoreation to the previous location is easy. Archived files are automaticly deleated after 90 days",
      inputSchema: { path: pathParam },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool("archive_note", async ({ path }: { path: string }) => {
      const res = await vault.archive(path);
      // Format the result as a string for the tool's return type
      if (res && typeof res === 'object' && 'from' in res && 'to' in res) {
        return `Archived from: ${res.from}\nArchived to: ${res.to}`;
      }
      return typeof res === 'string' ? res : 'Archive operation completed.';
    })
  );

  server.registerTool(
    "restore_note",
    {
      title: "Restore note",
      description: "Moves a note from the archive folder back to its original location. Use if the user asks for a note to be restored from the archive.",
      inputSchema: { path: pathParam },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool("restore_note", async ({ path }: { path: string }) => {
      const res = await vault.restore(path);
      // Format the result as a string for the tool's return type
      if (res && typeof res === 'object' && 'from' in res && 'to' in res) {
        return `Restored from: ${res.from}\nRestored to: ${res.to}`;
      }
      return typeof res === 'string' ? res : 'Restore operation completed.';
    })
  );

  server.registerResource(
    "vault-index",
    "vault://index",
    {
      title: "Vault index",
      description: "Every note in the vault with size and last-modified time.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const { notes } = await vault.list("", true);
      const text = notes.map((n) => `${n.path}\t${n.modified}`).join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );

  return server;
}
