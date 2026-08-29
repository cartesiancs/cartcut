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

## Layering

The track list reads top to bottom, and the top row is the front of the
picture: index 0 draws over everything under it, the way V2 sits over V1 in
Premiere. A clip's layer **is** its track. There is no per-clip "bring to
front", and `update_clip` will refuse `priority`.

So titles and captions belong on a text track above the video, and that is
where `add_text` and `add_subtitles` put them. When they cannot — a project
that already has a text track sitting under the picture — the result carries a
`warning` naming what is stacked over the text, and the fix is one call:

```
move_track({ trackId: "…", toIndex: 0 })
```

The same rule is what makes `add_shape` usable as a lower-third bar. The bar
has to be behind the words and in front of the picture, which means a row
between the two — not a property on the bar.

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

## Writing text for the screen

**A title takes no full stop.** "Chapter one", not "Chapter one." — a terminal
period on a title, a lower third, a name super or a chapter card reads as a
typo to anyone who watches video, and it is the clearest tell that a title was
written by something that thinks in prose. Keep a question mark or an
exclamation mark where the line genuinely asks or exclaims, and keep
punctuation *inside* a multi-clause line. Drop only the final period.

This bites hardest when the title is lifted from the transcript, because
`get_transcript` returns punctuated sentences: "So this is the part that
matters." becomes a title only once the period comes off.

**Captions are the opposite.** A subtitle transcribes speech and keeps the
sentence's own punctuation, full stop included. That is broadcast practice, and
it is what a viewer reads sentence boundaries from. Pass `add_subtitles` the
words as spoken.

Keep titles short. A screen title that needs a comma usually wants to be two
lines, or a shorter phrase.

## Other edits

| Want to | Use |
|---|---|
| Cut without deleting | `split_clip` |
| Change where a clip starts or ends | `trim_clip` (absolute times) |
| Reorder or restage clips | `move_clips` |
| Delete outright | `delete_clips` (`ripple: true` closes the gap) |
| Change which clip draws on top | `move_track` |
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

Transitions do not exist in the data model at all — the transition tab is an
empty panel. If the user asks for a cross-dissolve, say so plainly rather than
approximating it with cuts.

Everything else that used to be missing is here: filters (`set_video_filters`),
keyframe animation (`add_keyframes`, `set_animation`, `apply_animation_preset`),
shapes (`add_shape`), fonts (`list_fonts`, `set_text_font`) and grouping
(`group_clips`). Those are real work, not approximations.
