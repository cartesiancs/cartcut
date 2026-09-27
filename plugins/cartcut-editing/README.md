# Cartcut Editing

A Claude Code plugin that lets Claude edit video in the running Cartcut app:
cut editing driven by a transcript, subtitles, motion, transitions and effects.

It ships two things: the `cartcut-editing` skill, which is the editing
grammar Claude works to, and the connection to Cartcut's MCP bridge, so
installing the plugin is the whole setup. The skill is also available on its own
through the skills CLI, with the bridge added by hand.

## Install

Two routes. The plugin carries the bridge with it, so it is the one to take on
Claude Code. The skills CLI installs the skill alone, for any agent that reads a
`SKILL.md`, and leaves the bridge to you.

Take one and not both: with both in place you get two `cartcut` servers and two
copies of the skill.

### The plugin, on Claude Code

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

### The skill on its own, with `npx skills add`

```
npx skills add cartesiancs/cartcut --skill cartcut-editing -a claude-code -g
```

`-g` installs it for every project, at `~/.claude/skills/cartcut-editing/`.
Without it the skill lands in the current project's `.claude/skills/` and the
CLI writes a `skills-lock.json` in that project. `-a` names the agent, and the
CLI knows about eighty of them, so `-a codex`, `-a cursor` and the rest work the
same way. `npx skills update cartcut-editing` refreshes it later,
`npx skills remove cartcut-editing` drops it.

That installs the skill and nothing else, so add the bridge yourself: open
Cartcut, click the ⚡ icon at the bottom right, and run the command it hands you.

```
claude mcp add --transport http cartcut http://127.0.0.1:9826/mcp --header "Authorization: Bearer <the UUID>"
```

An agent other than Claude Code wants the same URL and the same header in
whatever its own MCP configuration looks like.

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

`claude mcp list` should show the bridge: `plugin:cartcut-editing:cartcut` on the
plugin route, plain `cartcut` on the skills route.

- **ECONNREFUSED**: Cartcut is not running, or the port was taken at startup.
  The ⚡ panel says which, and its button retries.
- **401**: the token is wrong. Recopy it from the ⚡ panel, then run
  `/plugin configure cartcut-editing`, or on the skills route
  `claude mcp remove cartcut` followed by the ⚡ line again.
- **No `cartcut` tools at all, but the skill loads**: you took the skills route
  and stopped there. `npx skills add` does not install an MCP server; run the ⚡
  line.
- **Two `cartcut` servers**, or the skill loading twice: both routes are
  installed. Drop one, with `/plugin uninstall cartcut-editing`, or with
  `npx skills remove cartcut-editing` and `claude mcp remove cartcut`.

## Working on the plugin

From a clone of this repository, register it as a local marketplace and the
plugin loads from the working tree:

```
/plugin marketplace add ./
/plugin install cartcut-editing@cartcut
```

The skills route reads a clone too, which is how to test the skill as that CLI
delivers it. Run it from outside the clone, or the install lands back inside the
repository:

```
npx skills add /path/to/cartcut --skill cartcut-editing -a claude-code
```

`claude plugin validate ./plugins/cartcut-editing --strict` checks the manifest.
The version in `.claude-plugin/plugin.json` and the one in the repository's
`.claude-plugin/marketplace.json` have to agree; `claude plugin tag` checks that
and cuts the release tag.

`npx skills add` has no manifest of its own here: it finds the skill by reading
`.claude-plugin/marketplace.json` and following the plugin's
`./plugins/cartcut-editing` source. So this is worth running after any move of
the skill directory or edit of that entry, and should report one skill:

```
npx skills add cartesiancs/cartcut --list
```
