# cartcut-input

What the mouse did, and when. A small Swift CLI over `NSEvent`'s global monitor,
spawned by the Electron main process the way `ffmpeg` and `cartcut-stt` are, so
that auto-zoom can trigger on clicks and not only on cursor dwell.

## Why it exists

No Electron or renderer API can see a click that lands in another application.
`screen.getCursorScreenPoint()` answers where the pointer *is* with no permission
and no native code, which is what the cursor track in
`electron/lib/recordSession.ts` is built on, and there is no equivalent for a
button.

## Build

```
npm run build:input                  # host arch, into bin/<platform>-<arch>/
node scripts/buildInput.mjs --all    # both macOS slices, what build:osx runs
```

`npm run dev` runs the first of these. It skips itself, with a message, on
Windows or on a Mac with no Swift compiler; unlike the speech sidecar there is no
SDK gate, because every API used has existed since macOS 10.6.

## Use

```
cartcut-input watch
cartcut-input probe --seconds 5
```

One JSON object per line on stdout; stderr is left for dyld and crash output.

```
{"type":"ready","installed":true,"trusted":false}
{"type":"event","kind":"down","button":0}
{"type":"event","kind":"drag","button":0}
{"type":"event","kind":"scroll","button":0}
{"type":"probe","events":37,"seconds":5,"trusted":false}
{"type":"error","code":"usage","message":"…"}
```

**It exits when stdin closes.** Main kills it on stop, but a crash between spawn
and kill would otherwise leave a process watching every click on the machine with
nobody listening.

## It emits no coordinates

A click's position is the pointer's position at that instant, and
`recordSession.ts#capturePointNow` already maps a screen point into capture frame
pixels exactly: through the display's `bounds` rather than its `scaleFactor`, so
it needs no separate case for a fractional Windows factor, and dropping a point
on another screen rather than clamping it.

Emitting our own would mean reproducing that from Cocoa's global coordinate
space, whose origin is the **bottom** left of the primary display with y
increasing upward, against Electron's, whose origin is the top left with y
increasing downward. The two differ by a flip about the primary display's top
edge, which is correct on one monitor and wrong on three, in a direction no node
suite can see. So this says *what* and main says *where*.

## No keycodes, now or ever

There is no key monitor here. When typing is added as a zoom trigger it will
report that *a* key went down and nothing more: a camera planner has no use for
the identity of a key, and writing one to disk beside a recording would make this
a keylogger.

That split is also the permission story. Apple documents a global monitor as
needing accessibility trust **for key events**, which leaves mouse events
needing none, so clicks ship and typing waits.

## Verifying the permission claim

`trusted` on the `ready` line is reported, never required, and main logs it. The
claim above is only actually tested when the **app** spawns this, because TCC is
granted per responsible process: running `probe` from a terminal tests that
terminal's grant, not Electron's.

So:

```
npm run start        # then record for a few seconds, clicking a few times
```

and look for `[record] input monitor ready` in the log. `trusted: false` with a
non-zero click count in the sidecar file is the claim holding. `trusted: false`
with zero clicks on a machine where you definitely clicked is the claim failing,
and `recordSettings.clickHighlight`'s comment becomes the plan: put clicks behind
the same opt-in typing was going to use.
