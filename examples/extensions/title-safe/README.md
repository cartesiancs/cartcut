# Title Safe

A worked example of a Cartcut extension.

It finds titles and captions whose box strays outside the broadcast-safe area,
shows them on a picture of the frame, and moves them back in a single undo
step. It can also stop an export while anything is still outside, if you ask
it to.

## Try it

**Extensions ▸ Load unpacked**, then pick this folder. Saving any file in it
restarts the extension host, so your next click runs the new code.

Add a few text clips, drag one near the edge of the frame, and open the
**Title Safe** tab in the sidebar.

## What it demonstrates

| Thing | Where |
| --- | --- |
| One undo step for a whole pass | `fixAll` in `main.js` |
| Per-clip data that survives save and reopen | `MOVED_KEY`, used by `fixAll` and `revertAll` |
| A panel in its own process, talking to its extension | `views/panel.js` |
| A command, a keybinding, a menu item and a status item | `package.json` |
| Settings the user can change | `contributes.configuration` |
| Vetoing an export | `onWillExport` |
| A tool Claude Code can call | `ai.registerTool` |

## The parts worth copying

**Batch anything that touches more than one clip.** Moving forty captions is
forty edits, and forty undo steps is a feature nobody dares run.
`commands.batch` makes the whole pass one thing to accept or reject, and a
step that throws leaves the timeline untouched.

```js
await cartcut.commands.batch([
  { name: "update_clip", params: { elementId, patch: { location: { x, y } } } },
  { name: "ext_set_element_data", params: { elementId, value: { movedFrom } } },
]);
```

**Record what you changed, on the clip itself.** `setElementData` is keyed by
your extension id, so nothing else can read or overwrite it, and it is saved
with the project. That is what makes "put everything back" exact rather than
approximate, a week later, on another machine.

Only the *first* move is recorded. Running the pass twice must not replace
where the caption originally sat with where this extension last put it.

**Let the panel ask, and answer from one place.** The page holds no state and
computes nothing: it draws what the extension sends and posts back what the
user clicked. That is why the panel and the status bar can never disagree
about how many captions are outside.

A view is the least trusted process here and has no way to run a command. Its
buttons post a message and the extension decides what that means.

**Default to saying nothing.** The export veto is off unless the user turns it
on, because it will be wrong sometimes: a caption bled off the edge on purpose
is a real choice. An extension that silently blocked exports would be
uninstalled the first time it guessed wrong about that.

## What it does not do

It measures each clip's own box. A caption that is animated or scaled may sit
somewhere else at a given frame, and this will not notice. Asking the renderer
where a clip actually is at a cursor is not something an extension can do, and
pretending otherwise would make the report confidently wrong.

## Layout

```
title-safe/
  package.json      the manifest: what it contributes and what it asks for
  main.js           runs in the extension host, with Node
  views/
    panel.html      served over cartcut-ext://, in its own process
    panel.css       a view inherits nothing from the editor
    panel.js        a file, not inline: the CSP is `script-src 'self'`
```
