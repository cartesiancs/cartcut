---
name: cartcut-editing
description: Edit video in the running Cartcut app — cut editing driven by a transcript, subtitles, trimming and rearranging clips. Use whenever the user asks to edit, cut, trim, caption, subtitle, or restructure a video, or refers to "the timeline", "the project", or "my edit". Requires Cartcut to be open with its MCP bridge connected.
---

# Editing video in Cartcut

Cartcut is a desktop video editor. It exposes its live timeline over MCP, so
you are editing the project the user is looking at, in real time. Your edits
appear in their preview immediately.

## Ground rules

**Everything is milliseconds.** Timeline milliseconds, absolute, from the start
of the project. Never seconds, never frames, never timecode. If the user says
"cut the first 30 seconds", that is `0`–`30000`.

**One instruction, one edit.** The batch tools exist so that a request like
"remove all the silences" is one `remove_ranges` call with fifty ranges, not
fifty calls. This matters more than it looks: each call is a separate undo
step, and a user who dislikes the result should get back to where they were
with one Cmd+Z, not fifty.

**Your edits share the user's undo history.** `undo` takes back the last edit
whoever made it. If you overshoot, undo — do not try to reconstruct the
previous state by hand, because you will get it subtly wrong.

**Clips are addressed by id.** Get ids from `list_clips`. They change when you
cut: a split produces a new clip with a new id, and the tool result tells you
which. Re-read rather than assuming an id survived.

## Start here, every time

```
get_project_overview     →  resolution, duration, tracks, how many clips
list_clips               →  the clips themselves, with their ids
```

Both are small. Do not skip them and guess.

## Cut editing from speech

This is the main workflow. The judgement is yours; the tools just carry it out.

1. `get_transcript` on the clip. Timings come back already mapped to the
   timeline, so you can use them directly.
2. Decide what to remove. Read the words — long pauses, filler ("um", "uh",
   "like"), false starts, repeated takes where the speaker restarts a sentence,
   tangents the user asked you to drop.
3. **One** `remove_ranges` call with all of it.

```
remove_ranges({
  elementId: "…",
  ranges: [ {startMs: 3120, endMs: 4020}, {startMs: 9500, endMs: 11200}, … ],
  ripple: true
})
```

Ranges are read against the clip as it is *now*, so you do not have to shift
later ranges to account for earlier cuts. `ripple: true` (the default) closes
the gaps, which is what makes speech play continuously — turn it off only when
the user wants the timing preserved.

Two judgement calls worth making deliberately:

- **Leave breathing room.** Cutting exactly on the word boundary clips
  consonants and sounds rushed. Around 100ms of padding either side is usually
  right.
- **Do not cut a pause to nothing.** A conversation with every gap removed
  sounds frantic. Trim long pauses down rather than deleting them.

For word-level precision, `get_transcript` with `granularity: "word"` — but it
is much larger, so scope it with `startMs`/`endMs`.

## Subtitles

`get_transcript` gives timeline-time segments. Feed them straight to
`add_subtitles` — one call, all lines:

```
add_subtitles({ items: [ {text: "…", startMs: 0, durationMs: 2400}, … ] })
```

They land on a single text track. If the result's `tracks` shows more than one,
some of your captions overlap in time — check the timings.

Styling defaults to a lower third sized from the project's own resolution, so a
vertical video gets captions in the right place without being told. Pass
`style` only when the user asks for something specific.

Use `add_text` for a single title, `add_subtitles` for anything plural.

## Other edits

| Want to | Use |
|---|---|
| Cut without deleting | `split_clip` |
| Change where a clip starts or ends | `trim_clip` (absolute times) |
| Reorder or restage clips | `move_clips` |
| Delete outright | `delete_clips` (`ripple: true` closes the gap) |
| Change text, colour, position, size, opacity | `update_clip` |
| Show the user what you did | `select_clips`, then `set_playhead` |

Timing is deliberately not writable through `update_clip` — `startTime`,
`duration` and `trim` are coupled, and writing one without the others produces
a clip that previews correctly and exports wrong. Use `trim_clip` and
`move_clips`.

## Confirm before large destruction

Cutting a few seconds out of a clip is ordinary work — just do it. But say what
you are about to do, and wait, when the edit is:

- most of a clip, or a whole clip
- more than a handful of clips at once
- anything the user described vaguely enough that you are guessing

Report what you actually removed afterwards, in seconds, so they can judge it:
"removed 14 ranges, 22s in total, from a 4m10s clip."

## When things do not work

- **Tools are missing entirely** — Cartcut is not running, or the bridge is
  off. Ask the user to open it; the connection command is under the ⚡ icon at
  the bottom right of the window.
- **"editor window is not available"** — the app is starting up, or was closed.
- **`get_transcript` fails** — transcription needs either a local
  speech-to-text server or an OpenAI API key, both set in that same panel.
- **An edit returns `ok: false`** — it was declined, not failed, and nothing
  changed. The `reason` says what was in the way, usually a neighbouring clip
  or times that miss the clip entirely.

## What is not here yet

Effects, filters, transitions and keyframe animation are not exposed. If the
user asks for a fade, a transition, a blur or a chroma key, say so plainly
rather than approximating it with cuts.
