# Don't Blink

A frame-by-frame rebuild of the motion graphics in Apple's "Don't Blink"
(the September 2016 event recap) as a CartCut template: 3,561 frames at
30 fps, 1920x1080, with the film's letterboxed panel.

Open it in the browser:

```
https://cartcut.cartesiancs.com/?template=dont-blink
```

The editor sets the project to the template's frame, rate and length, places
it at 0s and opens its slots.

## What is the original, and what is not

| Part | In this template |
| --- | --- |
| Every title: words, sizes, spacing, positions, zooms, fades, the closing wall | Measured from the film, frame by frame |
| Black and white panels, wipes, the battery, the bolt | Measured from the film |
| 25 footage shots | Slots holding stand-in clips; drop your own footage on each |
| Logos | Stand-in marks, also slots |
| Typeface | Inter Display (SIL OFL 1.1, `fonts/OFL.txt`) in place of SF Pro |
| Sound | None |

## How close it is

`examples/templates-source/dont-blink/verify.ts` renders every frame with
CartCut's own compositor and compares it with the film, as grey levels from 0
to 255:

| Frames | Count | Mean difference | Median |
| --- | --- | --- | --- |
| Titles and panels | 2,315 | 0.60 | 0.17 |
| Logos (stand-ins) | 47 | 18.8 | 8.4 |
| Footage (stand-ins) | 1,199 | by design | |

What remains on the title frames is the typeface: Inter's letter shapes are
not SF's, most visibly in `ƒ` and in the digits of the closing wall.

## Rebuilding

The template is generated from `examples/templates-source/dont-blink/spec.json`:

```
npx jiti examples/templates-source/dont-blink/gen.ts
```
