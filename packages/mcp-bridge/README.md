# @cartesiancs/cartcut-mcp

Connects Claude, and any other MCP client, to the
[CartCut](https://cartesiancs.com/cartcut) video editor running on your
computer. Claude edits the project you have open: cutting from a transcript,
adding captions, trimming and restaging clips, motion, transitions and effects.
Every edit lands in CartCut's own undo history, so ⌘Z takes it back.

CartCut runs its MCP server inside the app, on `http://127.0.0.1:9826/mcp`.
This package is the stdio side of that connection: the client starts it, and it
relays every message to the app and back. It needs no configuration: it reads
CartCut's token from CartCut's own settings.

## Requirements

- CartCut, open. [Download it here](https://github.com/cartesiancs/cartcut/releases).
- Node.js 18 or later, for `npx`.

## Install

### Claude Code

```
claude mcp add cartcut -- npx -y @cartesiancs/cartcut-mcp
```

Add `-s user` to have it in every project. For the editing skill as well, which
is what makes Claude a good editor rather than one that merely has the tools,
install the plugin instead:
[plugins/cartcut-editing](https://github.com/cartesiancs/cartcut/tree/main/plugins/cartcut-editing).
If the skill is not installed, the bridge tells Claude where to read it.

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "cartcut": {
      "command": "npx",
      "args": ["-y", "@cartesiancs/cartcut-mcp"]
    }
  }
}
```

### Codex

```
codex mcp add cartcut -- npx -y @cartesiancs/cartcut-mcp
```

## Configuration

Both variables are optional.

| Variable | Default | |
| --- | --- | --- |
| `CARTCUT_MCP_TOKEN` | read from CartCut's settings | The token under the ⚡ icon at the bottom right of the CartCut window. |
| `CARTCUT_MCP_URL` | `http://127.0.0.1:9826/mcp` | Where CartCut listens. |

Without `CARTCUT_MCP_TOKEN`, the token comes from CartCut's `config.json`:

- macOS: `~/Library/Application Support/cartcut-app/config.json`
- Windows: `%APPDATA%\cartcut-app\config.json`
- Linux: `~/.config/cartcut-app/config.json`

## Behaviour worth knowing

**CartCut can restart underneath a session.** Quit it, update it, open it
again: the next call opens a new session with the app and carries on, and the
client is told to re-read the tool list.

**A call is never sent twice.** If CartCut closes while a tool call is running,
the call is answered with an error rather than retried, because it may already
have changed the timeline. Look at the editor before asking again.

**Nothing leaves the machine.** The bridge only ever talks to the address above.

## Troubleshooting

- *"CartCut is not running, or its MCP bridge is off"*: open CartCut, then
  reconnect (`/mcp` in Claude Code).
- *"CartCut refused the token"*: `CARTCUT_MCP_TOKEN` is set to an old token.
  Unset it, or copy the current one from the ⚡ icon.
- *"There is no CartCut token"*: CartCut has never been opened on this account.
  Open it once.

`npx -y @cartesiancs/cartcut-mcp --version` prints the version. The bridge logs
to stderr and never to stdout, which carries the protocol.

## License

MIT
