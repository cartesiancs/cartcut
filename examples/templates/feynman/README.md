# Feynman

A 35-second tribute edit to Richard Feynman as a CartCut template: 1920x1080
at 60 fps, editorial serif titles over black-and-white shots.

Open it in the browser:

```
https://cartcut.cartesiancs.com/?template=feynman
```

The editor sets the project to the template's frame, rate and length, places
it at 0s and opens its slots.

## What is in it

| Part | In this template |
| --- | --- |
| Every title: words, type, layout and motion | The original edit's own HTML graphics |
| Film grain, glitch, chromatic aberration | The built-in effects, carried inside the template so a browser build draws them too |
| 21 shots and 11 photos | 32 slots holding stand-ins; drop your own footage on each |
| Typefaces | Playfair Display and Instrument Serif (SIL OFL 1.1, `fonts/OFL.txt`) |
| Sound | None |

A stand-in is a soft grey field in its shot's own light and dark, at the shot's
size and length, so a slot still reads as a bright or a dark shot. The original
edit used archive footage, photographs and a music track that are not ours to
publish, and none of them is in this folder.

## Where the titles draw

The titles are HTML graphics. They draw in the desktop app, and in a browser
only where Chrome's html-in-canvas API is available: on a site that presents an
origin-trial token (`apps/app/origin-trial.txt`), or with the feature switched
on in `chrome://flags`. Anywhere else the template plays without its titles.

## Rebuilding

The folder is generated from the original project, which is not in this
repository:

```
npx jiti examples/templates-source/feynman/build.ts <project.ngt>
```
