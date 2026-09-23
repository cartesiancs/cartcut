# Cartcut Editing

A Claude Code plugin that lets Claude edit video in the running Cartcut app:
cut editing driven by a transcript, subtitles, motion, transitions and effects.

It ships two things: the `cartcut-editing` skill, which is the editing
grammar Claude works to, and the connection to Cartcut's MCP bridge, so
installing the plugin is the whole setup.

## Install

```
/plugin marketplace add cartesiancs/cartcut
/plugin install cartcut-editing@cartcut
```

The install asks for your Cartcut MCP token. Open Cartcut, click the ⚡ icon at
the bottom right, and copy the connection command; the token is the UUID after
`Bearer `. It is generated once per machine and kept, so you paste it once.

The CLI form takes it as a flag instead:

```
claude plugin install cartcut-editing@cartcut --config mcp_token=<the UUID>
```

To change it later: `/plugin configure cartcut-editing`.

## Use it

Open a project in Cartcut, then ask in plain language: "cut the silences out of
this", "add subtitles", "trim the first 30 seconds", "punch in when he raises
his voice". The skill loads itself when the request is about editing.

Claude edits the project you are looking at, live, and its edits share your undo
history, so ⌘Z takes back what it did.

## Requirements

- Cartcut running, with a project open. The bridge listens on
  `127.0.0.1:9826` and starts with the app.
- Transcription needs either a local speech-to-text server or an OpenAI API
  key, both set in the same ⚡ panel. Everything that does not read speech works
  without one.

## If it does not connect

`claude mcp list` should show `plugin:cartcut-editing:cartcut`.

- **ECONNREFUSED**: Cartcut is not running, or the port was taken at startup.
  The ⚡ panel says which, and its button retries.
- **401**: the token is wrong. Recopy it from the ⚡ panel and run
  `/plugin configure cartcut-editing`.
- **Two `cartcut` servers**: you previously ran the `claude mcp add` line by
  hand. Drop it with `claude mcp remove cartcut`; the plugin supplies it now.

## Working on the plugin

From a clone of this repository, register it as a local marketplace and the
plugin loads from the working tree:

```
/plugin marketplace add ./
/plugin install cartcut-editing@cartcut
```

`claude plugin validate ./plugins/cartcut-editing --strict` checks the manifest.
The version in `.claude-plugin/plugin.json` and the one in the repository's
`.claude-plugin/marketplace.json` have to agree; `claude plugin tag` checks that
and cuts the release tag.
