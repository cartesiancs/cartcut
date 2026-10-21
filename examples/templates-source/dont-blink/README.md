# Don't Blink: source

`spec.json` is what was measured from the film; `gen.ts` turns it into
`examples/templates/dont-blink/template.ngt`; `verify.ts` renders that template
with CartCut's compositor and compares it with the film. This folder is not
served by the web build and not part of the app's type program.

```
npx jiti examples/templates-source/dont-blink/gen.ts
npx jiti examples/templates-source/dont-blink/verify.ts \
  examples/templates/dont-blink <film.mp4> <out dir> [from-to] [sheet every N]
```

`verify.ts` writes `metrics.json` (mean absolute difference per frame, over the
panel rows) and, with `PAIRS=n,n,...`, a picture of the film above the render
for each frame named.

## The spec

- `texts`: one entry per title, with its font size `F`, letter spacing `L`, box
  `W` x `H`, and a pose per frame (`x`, `y`, scale `s`, opacity `op`, and for a
  word revealed letter by letter, a strength per letter `ops`). `gen.ts` turns
  each pose series into linear keyframes, keeping only the frames a straight
  line between its neighbours cannot reproduce.
- `white`, `rects`, `shapes`: panels, the battery and the bolt.
- `media`, `logos`: the slots, with the frames they cover.

## How it was measured

Each frame of the film was decoded and classified as footage, logo or title.
On a title frame, ink was separated from the panel (white or #111), cut into
lines and linked across frames into tracks, and each track's text read by OCR
and then checked by hand. A track's size, spacing and per-frame pose were then
fitted by Nelder-Mead against CartCut's own `renderText`, so the template is
measured in the renderer that draws it. A zoom through a giant letter is that
same word posed about the zoom's fixed point; the word seen inside the letter
is the next scene's, drawn in its own colour on top.
