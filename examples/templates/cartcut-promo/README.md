# CartCut Promo

A 92-second product film for CartCut as a template: kinetic titles, screen
recordings of the editor and soft gradient backgrounds, 1920x1080 at 60 fps.

Open it in the browser:

```
https://cartcut.cartesiancs.com/?template=cartcut-promo
```

The editor sets the project to the template's frame, rate and length, places
it at 0s and opens its slots.

## What is in it

| Part | In this template |
| --- | --- |
| Titles, the prompt card, the Edit/Ask toggle, the cursor | The original edit's own HTML graphics |
| Gradient backgrounds | The original's shader graphics, drawn with WebGL in any browser |
| 13 screen recordings and the logo | The originals, each a slot; drop your own on any of them |
| Typeface | Inter (SIL OFL 1.1, `fonts/OFL.txt`), weight for weight, in place of Suisse Int'l |
| Sound | None |

The recordings are re-encoded and cut to the stretch the edit shows, plus a
quarter second either side, which takes them from 311 MB to under 20. Each clip's
trim moved by exactly its cut, so every frame lands where it did.

The original edit is cut to a music track that is not ours to publish, and the
one recording that carried sound (an export of a demo edit, with its music) is
silent here. Add a music track of your own.

## Where the titles draw

The titles are HTML graphics, drawn live by the browser's html-in-canvas API:
in the desktop app, and in Chrome and Edge 157 or later, which turn it on by
default. Chrome 155 and 156 draw them on a site that presents an origin-trial
token (`apps/app/origin-trial.txt`). Safari and Firefox do not have the API:
there the template plays without its titles, and the editor says so once.

## Rebuilding

The folder is generated from the original project, which is not in this
repository, and from the static Inter 4.1 files
(https://github.com/rsms/inter/releases):

```
npx jiti examples/templates-source/cartcut-promo/build.ts <project.ngt> <folder holding Inter-Regular.ttf, Inter-SemiBold.ttf and LICENSE.txt>
```
