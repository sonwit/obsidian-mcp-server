import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * All file access goes through this class. It enforces:
 * - paths are relative to the vault and can never leave it (no "..", no absolute paths, no symlink escapes)
 * - hidden files and folders (.obsidian, .trash, .git, ...) are invisible and untouchable
 * - only Markdown notes (.md) can be read or written
 * - nothing is ever deleted or moved
 */

export class VaultError extends Error {}

export interface NoteInfo {
  path: string;
  size: number;
  modified: string;
}

export interface Note extends NoteInfo {
  content: string;
  version: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

const MAX_FILES = 5000;

export function versionOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

export class Vault {
  readonly root: string;
  readonly maxWriteBytes: number;

  constructor(root: string, maxWriteBytes: number) {
    this.root = root;
    this.maxWriteBytes = maxWriteBytes;
  }

  /** Validate a vault-relative path and turn it into clean segments. */
  private segments(relPath: string, { allowEmpty = false } = {}): string[] {
    const cleaned = relPath.normalize("NFC").replace(/\\/g, "/").trim();
    if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
      throw new VaultError(`Use a path relative to the vault, not an absolute path: "${relPath}"`);
    }
    const parts = cleaned.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0 && !allowEmpty) throw new VaultError("The path is empty.");
    for (const part of parts) {
      if (part === "..") throw new VaultError(`".." is not allowed in paths: "${relPath}"`);
      if (part.startsWith(".")) {
        throw new VaultError(`Hidden files and folders (like .obsidian) are not accessible: "${relPath}"`);
      }
    }
    return parts;
  }

  private requireMarkdown(parts: string[], relPath: string): void {
    const name = parts[parts.length - 1];
    if (!name.toLowerCase().endsWith(".md")) {
      throw new VaultError(`Only Markdown notes (.md) are supported: "${relPath}"`);
    }
  }

  /**
   * Resolve segments to a real absolute path, matching existing entries Unicode-insensitively
   * (macOS may store æøå decomposed). Guarantees the result is inside the vault, even through symlinks.
   */
  private async resolve(parts: string[]): Promise<string> {
    let current = this.root;
    for (const part of parts) {
      let next = path.join(current, part);
      if (!existsSync(next) && existsSync(current)) {
        const entries = await readdir(current).catch(() => [] as string[]);
        const match = entries.find((e) => e.normalize("NFC") === part);
        if (match) next = path.join(current, match);
      }
      current = next;
    }
    this.assertInside(current);
    return current;
  }

  private assertInside(absPath: string): void {
    // Check the deepest existing ancestor through realpath so a symlink cannot point outside.
    let probe = absPath;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      throw new VaultError("The path points outside the vault.");
    }
  }

  private toRel(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join("/").normalize("NFC");
  }

  /** Walk all visible Markdown files below a folder. */
  private async walk(dirAbs: string, recursive: boolean, out: string[] = []): Promise<string[]> {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (out.length >= MAX_FILES) break;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory() && recursive) {
        await this.walk(abs, recursive, out);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(abs);
      }
    }
    return out;
  }

  async list(folder = "", recursive = true): Promise<{ notes: NoteInfo[]; folders: string[] }> {
    const parts = this.segments(folder, { allowEmpty: true });
    const dirAbs = await this.resolve(parts);
    const s = await stat(dirAbs).catch(() => null);
    if (!s?.isDirectory()) throw new VaultError(`Folder not found: "${folder}".`);

    const files = await this.walk(dirAbs, recursive);
    const notes = await Promise.all(
      files.map(async (abs) => {
        const fs = await stat(abs);
        return { path: this.toRel(abs), size: fs.size, modified: fs.mtime.toISOString() };
      }),
    );
    notes.sort((a, b) => a.path.localeCompare(b.path, "nb"));

    const folders = (await readdir(dirAbs, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => this.toRel(path.join(dirAbs, e.name)))
      .sort((a, b) => a.localeCompare(b, "nb"));

    return { notes, folders };
  }

  async read(relPath: string): Promise<Note> {
    const parts = this.segments(relPath);
    this.requireMarkdown(parts, relPath);
    const abs = await this.resolve(parts);
    const fs = await stat(abs).catch(() => null);
    if (!fs?.isFile()) throw new VaultError(`Note not found: "${relPath}". Use list_notes or search_notes to find the right path.`);
    const content = await readFile(abs, "utf8");
    return {
      path: this.toRel(abs),
      size: fs.size,
      modified: fs.mtime.toISOString(),
      content,
      version: versionOf(content),
    };
  }

  async search(query: string, folder = "", maxResults = 20): Promise<SearchHit[]> {
    const needle = query.normalize("NFC").toLowerCase().trim();
    if (!needle) throw new VaultError("The search query is empty.");
    const dirAbs = await this.resolve(this.segments(folder, { allowEmpty: true }));
    const files = await this.walk(dirAbs, true);
    const hits: SearchHit[] = [];

    for (const abs of files) {
      const rel = this.toRel(abs);
      if (rel.toLowerCase().includes(needle)) hits.push({ path: rel, line: 0, text: "(match in file name)" });
      const lines = (await readFile(abs, "utf8")).split("\n");
      lines.forEach((text, i) => {
        if (hits.length < maxResults && text.normalize("NFC").toLowerCase().includes(needle)) {
          hits.push({ path: rel, line: i + 1, text: text.trim().slice(0, 200) });
        }
      });
      if (hits.length >= maxResults) break;
    }
    return hits.slice(0, maxResults);
  }

  /** Write atomically: temp file in the same folder (hidden, so sync ignores it), then rename. */
  private async writeAtomic(abs: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxWriteBytes) {
      throw new VaultError(`Content is too large (${bytes} bytes, max ${this.maxWriteBytes}).`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    this.assertInside(path.dirname(abs));
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, content, "utf8");
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async create(relPath: string, content: string): Promise<Note> {
    const parts = this.segments(relPath);
    this.requireMarkdown(parts, relPath);
    const abs = await this.resolve(parts);
    if (existsSync(abs)) {
      throw new VaultError(`"${relPath}" already exists. Use edit_note, append_to_note or replace_note.`);
    }
    await this.writeAtomic(abs, content);
    return this.read(relPath);
  }

  async replace(relPath: string, content: string, expectedVersion: string): Promise<Note> {
    const current = await this.read(relPath);
    if (current.version !== expectedVersion) {
      throw new VaultError(
        `The note has changed since you read it (version ${current.version}, you gave ${expectedVersion}). Read it again and retry.`,
      );
    }
    await this.writeAtomic(await this.resolve(this.segments(relPath)), content);
    return this.read(relPath);
  }

  async edit(relPath: string, oldText: string, newText: string): Promise<Note> {
    if (!oldText) throw new VaultError("old_text cannot be empty.");
    const current = await this.read(relPath);
    const count = current.content.split(oldText).length - 1;
    if (count === 0) {
      throw new VaultError(`old_text not found in "${relPath}". Read the note again; it may have been changed from another device.`);
    }
    if (count > 1) {
      throw new VaultError(`old_text occurs ${count} times in "${relPath}". Include more surrounding text to make it unique.`);
    }
    const updated = current.content.replace(oldText, () => newText);
    await this.writeAtomic(await this.resolve(this.segments(relPath)), updated);
    return this.read(relPath);
  }

  /**
   * Append text at the end of the note, or at the end of the section under a heading
   * (just before the next heading of the same or higher level).
   */
  async append(relPath: string, text: string, heading?: string): Promise<Note> {
    const current = await this.read(relPath);
    const lines = current.content.split("\n");
    const block = text.replace(/\n+$/, "");

    if (!heading) {
      const base = current.content.replace(/\n*$/, "");
      const updated = (base ? `${base}\n` : "") + `${block}\n`;
      await this.writeAtomic(await this.resolve(this.segments(relPath)), updated);
      return this.read(relPath);
    }

    const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
    const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === wanted);
    if (start === -1) {
      const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());
      throw new VaultError(`Heading "${heading}" not found in "${relPath}". Headings in the note: ${headings.join(" | ") || "(none)"}`);
    }
    const level = lines[start].match(/^#+/)![0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    // Insert after the last non-empty line of the section.
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    const toInsert = block.split("\n");
    const needsGapAfter = insertAt < lines.length && lines[insertAt].trim() !== "";
    lines.splice(insertAt, 0, ...toInsert, ...(needsGapAfter ? [""] : []));
    await this.writeAtomic(await this.resolve(this.segments(relPath)), lines.join("\n"));
    return this.read(relPath);
  }
}
