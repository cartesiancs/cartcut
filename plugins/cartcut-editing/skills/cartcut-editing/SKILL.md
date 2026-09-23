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

## Editing a whole video

For anything bigger than a single tweak, the shape is: **look → propose →
wait → apply once → check**.

```
get_edit_brief()      →  the project's shape, and a style profile with numbers
get_transcript()      →  the words
analyze_audio()       →  the silences, the beats
                      →  propose in plain English, and WAIT
apply_edit_plan()     →  the whole edit, one Cmd+Z
get_contact_sheet()   →  look at what you made
```

**Propose before you cut.** Four to eight sentences: the shape you have in
mind, which takes you are keeping and why, where it tightens, whether you are
adding motion or captions, how long it will run. Then stop and let the user
answer. An edit they did not ask for is work they have to undo, and the cost of
asking is one message.

**Then apply it in one call.** `apply_edit_plan` puts the whole thing behind a
single undo. Doing the same work through the individual tools leaves a history
entry each, and an edit that takes sixty undos to reject is one the user cannot
reject.

### The style profile is where the numbers live

`get_edit_brief` returns a profile — cut padding, minimum shot length, how
often to push in and how hard, which transitions this style uses, how many
words a caption line holds. **Use its numbers rather than inventing your own**,
because that is what makes an edit read as one piece instead of a series of
separate decisions.

It is chosen from what the material is, and it tells you why. If the reason
sounds wrong for what the user wants, say so and offer one of `otherStyles` —
that is a one-sentence conversation, not a reason to guess.

Profiles are files. A user who wants their own taste writes one and drops it in
their styles folder; nothing about the grammar below is fixed in code.

### The rules that do not come from the profile

These hold whatever style is in play:

1. **Never cut inside a word.** Snap every edge to a word boundary from the
   transcript, then pad it by the profile's `paddingMs`.
2. **Trim a pause, do not delete it.** Speech with every gap removed sounds
   frantic. The profile's `maxSilenceMs` is what a long pause becomes, not what
   it has to be under.
3. **Let a move finish before a cut.** A punch-in still travelling when the shot
   changes reads as a mistake.
4. **One idea per moment.** Do not put a transition on a cut where a clip is
   already moving, and do not stack an effect on a punch-in. Something moving is
   enough.
5. **A move needs a reason.** Tie it to what the audio or the words mark —
   the profile's `onEmphasis` says whether to. Evenly spaced punch-ins read as a
   tic.
6. **Cut to `beats`, never to bpm arithmetic**, and only when
   `tempo.confidence` is high.
7. **Look before you say you are done.** `get_contact_sheet` at the cuts and at
   anything you added. You will find things you cannot predict — a caption on a
   face, a cut on a blink, a title against a white frame.
8. **Say what you did, in seconds.** "Removed 14 ranges, 22s from a 4m10s clip,
   and put a push-in on the three moments he raises his voice."

## Start here, every time

```
get_project_overview     →  resolution, duration, tracks, how many clips
list_clips               →  the clips themselves, with their ids
```

Both are small. Do not skip them and guess.

Then read the material before deciding anything: `get_transcript` for the words
and `analyze_audio` for the sound. Both are cached, so the cost is paid once.

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

## Look at what you made

`get_contact_sheet` renders frames of the **composed timeline** into one PNG
grid and gives you its path. Read that file and you are looking at the picture
the export would deliver — titles, shapes, filters, effects and all, drawn by
the exporter's own renderer rather than pulled out of the source.

```
get_contact_sheet({ atMs: [1000, 8000, 15000], columns: 3 })
get_contact_sheet({ startMs: 0, endMs: 30000, count: 9 })
```

Use it when the answer depends on what is actually on screen:

- after adding a title — is it legible against what is behind it, and is it
  covering the speaker's face?
- at a cut — did it land on a black frame or a blink?
- after keyframing a move — does the move look like what you meant?
- before telling the user you are done.

Every tile carries its own timestamp, so what you see is directly actionable.
Each frame costs a video seek, so ask about the stretch you care about rather
than the whole project — and if the result carries a `warning`, some footage had
not finished decoding and those tiles are not to be trusted.

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

Entries may also carry two things worth acting on:

- **`confidence`**, 0–1, where the back end reports one. It measures how sure
  the *recogniser* was, not how sure the speaker sounded. Treat a low score as
  "these may not be the words that were said": check before putting that line
  on screen as a caption, and pick a confident phrase when you need a pull
  quote. A local WhisperX server scores every word; OpenAI scores whole
  segments and no words at all.
- **`speaker`**, when diarisation is on. This is what lets you cut between
  people, caption them apart, or keep one person's answer and drop the
  question. Segments break on a change of speaker, so a caption line never
  mixes two voices.

Both are absent rather than guessed when the back end does not report them.

### Listen as well as read

The transcript tells you what was said. `analyze_audio` tells you what the
recording sounds like, and the two disagree more often than you would think:

- **Dead air the words cannot show you.** A gap between two sentences is in the
  transcript; the eight seconds of room tone before the speaker starts, the
  breath held mid-take, the silence after the last word — those are only in the
  signal. Cutting them is most of what makes an edit feel tight.
- **Where the hits are.** `onsets` are percussive attacks — over music the
  subdivisions, over speech consonants and desk knocks. They are finer than the
  beat, so they are what you snap an exact cut to.
- **Where the beats are.** `beats` is a measured list, not a grid computed from
  the tempo. Cut on it. Do **not** work out beat times from `tempo.bpm`
  yourself: a grid extrapolated from a rate accumulates error and walks off the
  music, and a drifting grid is worse than none because it still looks
  deliberate. `beats` comes back empty when there is no pulse worth following,
  and empty is the honest answer — speech has no beat.

Use `beats` to decide the *spacing* of cuts and `onsets` to place each one
exactly.

All of it comes back on the timeline, so it pairs straight with `remove_ranges`
and `split_clip`. It is cached per file, so ask early and ask freely.

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

## Motion that reads as deliberate

**Set `easing` on every `add_keyframes` entry, or the move will be soft.** With
none, a keyframe gets handles that leave and arrive at zero velocity. That is
the gentlest curve there is, and applied to everything it is the single biggest
reason agent-made motion drifts instead of landing.

An easing shapes the segment *leaving* the entry it is written on — the same
reading as CSS — so the last entry's is ignored.

| Want | Use |
|---|---|
| A punch-in that lands | `snap` |
| A move that passes the target and settles back | `overshoot` |
| A move that winds up before it goes | `anticipate` |
| A constant drift, Ken Burns | `linear` |
| The CSS defaults | `ease_in`, `ease_out`, `ease_in_out` |
| Anything else | `[x1, y1, x2, y2]` control points |

A bounce is not one curve — it reverses direction several times, which a single
cubic cannot. Author it as several keyframes.

**Scale is in tenths** — 10 is unscaled, 12 is 120%.

### Reach for a preset first

`apply_animation_preset` already has the curve and the length right, and it is
one undo step:

| Want | Preset |
|---|---|
| A hard push in | `punch_in` |
| A slow Ken Burns | `drift` |
| A zoom that passes its target | `overshoot_in` |
| Something arriving with life | `pop` |
| A title landing hard | `slam` |
| An impact | `shake` |
| Coming in off-angle | `rotate_settle` |
| Opacity in or out | `fade_in`, `fade_out` |

**Leave `durationMs` off unless you mean it.** Each preset carries the length it
was designed around, and they differ by more than an order of magnitude — a
punch is 180ms, a drift is four seconds. A punch stretched to a second is not a
punch.

### Zooming towards something

Scale animates about the clip's **centre**, so a zoom always converges on the
middle. To punch in on a face at the left of frame, pass `focus` — a point in
the clip's own box, 0–100 per axis — and the preset pushes the picture the other
way as it grows so that point stays put. `{x: 50, y: 50}` is the centre and
changes nothing. Hand-authored keyframes get no such help: there you have to
counter-animate `position` yourself.

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

## Transitions and effects

Both are real, both export, and both are yours.

**A transition sits on a cut**, not on a clip — it mixes two rendered frames,
so it needs the outgoing and incoming clip. `list_cuts` finds them:

```
list_cuts()                         →  fromId, toId, and how long it could be
list_transition_presets()           →  37 of them, with their parameters
add_transition({ fromId, toId, presetId: "…" })
```

Neither clip moves or is trimmed. The frames the mix needs are the ones already
in the files either side of the trim, and where the source runs out the clip
holds its last frame — `realFootageMs` from `list_cuts` says how much would be
real. A short dissolve that freezes slightly is normal; trim the clips if you
want it all real.

Reach for a cross-dissolve when the cut should be invisible, and for `whip-pan`,
`cross-zoom`, `glitch` or `flash` when it should be felt. Do not stack one on
top of a punch-in — the clip is already moving.

**An effect applies to everything painted beneath it.** It gets its own row,
and where that row sits *is* the control: the first one lands at the very top,
covering the whole composite, and you narrow it by moving its track down.

```
list_effect_presets({ category: "texture" })
add_effect({ presetId: "…", startMs, durationMs, intensity: 60 })
```

`intensity` is static, so an effect that comes and goes is several short effect
clips rather than a keyframed one.

## What is not here yet

Nothing about the picture is missing any more.
