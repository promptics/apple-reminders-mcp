# apple-reminders-mcp

> A thin **Model Context Protocol** server that exposes Apple Reminders to MCP
> clients (Claude Code, Claude Desktop, Cursor, etc.).

Built on top of [`keith/reminders-cli`](https://github.com/keith/reminders-cli),
which talks to **EventKit** directly — so iCloud-synced lists work out of the
box, no AppleScript timeouts, no stubbed-out responses.

## Motivation

I wanted to manage tasks and TODOs from Claude Cowork using Apple Reminders,
since Reminders is tightly integrated with macOS and already part of my
workflow. I tried [`dhravya/apple-mcp`](https://github.com/dhravya/apple-mcp)
— the only existing MCP I came across — but its Reminders support didn't
actually work for me (see *Why not* below). Claude proposed wrapping
[`keith/reminders-cli`](https://github.com/keith/reminders-cli) with a thin
MCP shim instead, and built this. There may be other solutions out there;
this is the one Claude built for me. Feel free to use it.

## Why not `apple-mcp`?

[`dhravya/apple-mcp`](https://github.com/dhravya/apple-mcp) v1.0.0 has its
Reminders fetching effectively stubbed out — `getAllReminders` returns `[]`
with a comment about AppleScript being "too slow and unreliable". This wrapper
sidesteps the problem entirely by delegating to a maintained Swift binary.

## Tools

| Tool          | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `list_lists`  | Names of every reminder list                               |
| `show`        | Items in one list (open by default; supports filter / sort)|
| `show_all`    | Items across all lists                                     |
| `add`         | Create a reminder (`dueDate`, `priority`, `notes` optional)|
| `complete`    | Mark complete by `externalId` (preferred) or numeric index |
| `uncomplete`  | Unmark complete                                            |
| `delete`      | Delete                                                     |
| `edit`        | Change title                                               |
| `new_list`    | Create a list                                              |

`show` returns objects shaped like:

```json
{
  "externalId": "958754B0-…",
  "title": "Finley Klavierunterricht",
  "list": "Family",
  "isCompleted": false,
  "priority": 0,
  "dueDate": "2026-05-15T07:00:00Z",
  "notes": "…"
}
```

Always pass `externalId` to `complete` / `delete` / `edit` for stable
references — numeric indexes shift as items are added or completed.

## Install

### Prerequisites

```bash
brew install keith/formulae/reminders-cli   # the underlying CLI
brew install oven-sh/bun/bun                # to run this server
```

Grant **Reminders** permission to whichever app spawns the MCP — typically
your terminal or Claude Code: System Settings → Privacy & Security → Reminders.

### Claude Code (recommended)

Run via `bunx` against the published package:

```bash
claude mcp add apple-reminders -s user -- bunx --no-cache apple-reminders-mcp@latest
```

…or against a local clone for development:

```bash
git clone https://github.com/promptics/apple-reminders-mcp.git
cd apple-reminders-mcp
bun install

claude mcp add apple-reminders -s user -- bun "$PWD/index.ts"
```

Restart Claude Code; tools surface as `mcp__apple-reminders__*`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-reminders": {
      "command": "bunx",
      "args": ["--no-cache", "apple-reminders-mcp@latest"]
    }
  }
}
```

### Cursor / other MCP clients

Use the same stdio command (`bunx --no-cache apple-reminders-mcp@latest`) in
the client's MCP configuration.

## Examples

Once connected, you can ask the LLM things like:

- *"What's open on my Family list?"*
- *"Add 'Pick up dry cleaning' to Haushalt for Friday at 5pm"*
- *"Mark the Klavierunterricht reminder complete"*
- *"Show me everything due this week"*

The LLM will call the appropriate tool; the MCP returns structured JSON it can
reason about.

## Development

```bash
bun install
bun run index.ts   # speaks MCP over stdio; pipe JSON-RPC for manual testing
```

Quick handshake + tools/list smoke test:

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 1) \
  | bun run index.ts
```

End-to-end (calls the real CLI, requires Reminders permission):

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_lists","arguments":{}}}'; sleep 2) \
  | bun run index.ts
```

## Roadmap

- [ ] Publish to npm so `bunx apple-reminders-mcp@latest` resolves
- [ ] CI on GitHub Actions (lint + smoke test on macOS runners)
- [ ] Optional `priority` typing once `reminders-cli` documents accepted values
- [ ] Consider exposing reminder `notes` editing (currently CLI-side only)

## Contributing

Issues and PRs welcome — particularly:
- Bug reports with reproducing JSON-RPC requests
- New tools that map cleanly onto a `reminders-cli` subcommand
- Documentation for additional MCP clients

## License

MIT — see [LICENSE](LICENSE).

`reminders-cli` itself is © Keith Smiley, also MIT-licensed; this project is an
independent wrapper that spawns it as a subprocess at runtime.
