# obsidian-mcp-server

An MCP server that gives AI agents read and write access to a single Obsidian vault. It works directly on the Markdown files in a folder and speaks Streamable HTTP. It is stateless, so every request gets its own server and transport.

## Tools

| Tool | What it does |
|---|---|
| `list_notes` | Lists notes and folders |
| `read_note` | Reads a note, with a version hash |
| `search_notes` | Text search in file names and contents |
| `create_note` | Creates a new note, fails if it already exists |
| `edit_note` | Replaces one exact piece of text (must be unique) |
| `append_to_note` | Adds text at the end, or under a heading |
| `replace_note` | Overwrites the whole note, requires the version from the latest read |
| `recent_changes` | Lists notes changed in the last N days, newest first |
| `week_progress` | Counts task checkboxes per note and per heading in a folder, with frontmatter |
| `archive` | Moves a note to the archive folder |
| `restore` | Moves a note the archive folder to its original location |

Plus the resource `vault://index`, which lists every note.

Notes can be changed from other devices while an agent is working on them. `edit_note` fails if the text is no longer there, and `replace_note` fails if the version is stale. The agent then has to read the note again.

## About the vault

The server tells agents to read `About the vault.md` at the start of a session, if that note exists. Put it in the vault root and use it to describe the structure and conventions you want agents to follow: which folders exist, how tasks and links are written, and what agents may or may not change.

## Safeguards

- Only `.md` files
- No access to hidden files and folders (`.obsidian`, `.trash`)
- No `..` or absolute paths, and symlinks cannot point outside the vault
- The server can move files to the archive folder if the user ask for it. They can also be restored.
- Atomic writes, at most 1 MB per write
- The log shows which notes were touched, never their content

## Authorization

`/mcp` requires the header `Authorization: Bearer <token>`. The token is never accepted in the URL, and the server will not start without a valid `MCP_TOKEN`. `/healthz` is open and only responds with `{"ok":true}`.

## Configuration

Set as environment variables. See `.env.example` for a template.

| Variable | Default | What it is |
|---|---|---|
| `VAULT_ROOT` | (required) | Path to the vault folder |
| `MCP_TOKEN` | (required) | At least 32 characters, only `A-Z`, `a-z`, `0-9`, `_` and `-`. Generate one with `openssl rand -hex 32` |
| `HOST` | `127.0.0.1` | Address the server listens on |
| `PORT` | `3333` | Port the server listens on |
| `MAX_WRITE_BYTES` | `1000000` | Maximum size of a single write |

## Development

Requires Node 22.18 or newer. The code runs as TypeScript directly, with no build step.

```bash
npm install
cp .env.example .env     # fill in VAULT_ROOT and MCP_TOKEN
npm run dev
npm run typecheck
npm run smoke            # against a running server, creates _smoketest in the vault
npm run inspector        # Streamable HTTP, URL http://127.0.0.1:3333/mcp, header Authorization: Bearer ...
```

## License

MIT, see [LICENSE](LICENSE).
