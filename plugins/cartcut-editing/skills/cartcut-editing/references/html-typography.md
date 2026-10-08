# Writing a graphic program

A graphic is drawn by a program you hand to `check_program`, `add_graphic`,
`set_graphic` or `apply_typography` as `program`. This file is the whole
contract. Start from an installed preset when one is close: `get_program` on a
clip that uses it returns its sources, and editing those is faster than starting
blank.

## The shape

```json
{
  "kind": "graphic",
  "name": "Wave title",
  "category": "kinetic",
  "render": {
    "type": "html",
    "html": "<h1 class=\"title\" data-param=\"title\" data-split=\"chars\"></h1>",
    "css": ".title { font-family: var(--font); color: var(--color); ... }",
    "layout": "scale",
    "designSize": { "width": 1600, "height": 400 },
    "bleed": 80,
    "bindings": { "text": "title", "font": "font", "color": "color", "fontSize": "size" }
  },
  "params": [
    { "key": "title", "label": "Title", "type": "text", "default": "Hello" },
    { "key": "font", "label": "Font", "type": "font", "default": "bundled:Anton-Regular.ttf" },
    { "key": "color", "label": "Colour", "type": "color", "default": "#ffffff" },
    { "key": "size", "label": "Size", "type": "number", "default": 160, "min": 20, "max": 400 }
  ]
}
```

- `html` is a body fragment: no `<html>`, `<head>`, `<body>`, `<style>` or
  `<script>`. Styles go in `css`.
- `layout: "reflow"` (the default) lays the HTML out at the clip's own box, so
  resizing the clip re-wraps it. `layout: "scale"` lays it out at `designSize`
  and scales the picture to the box, so a keyframed size never reflows. Titles
  want `scale`; a paragraph that should re-wrap wants `reflow`.
- `designSize` is required for `scale` and is also the box a new graphic takes.
- `bleed` is how far, in layout px, the picture may spill past the box on every
  side. Drawing is clipped to the box plus the bleed, so anything that moves
  outside the box (a glow, a shadow, a 3D flip, letters flying in) needs it.
  Keep it as small as the motion allows: the raster grows with it.
- `bindings` says which parameter receives each field of a text clip converted
  with `apply_typography`: `text`, `font`, `color`, `fontSize`, `align`. A field
  with no binding is reported as dropped.
- Sources are at most 512 KB each and 1 MB together.

**One line of words.** A title program has one text parameter and one element
that shows it: no kicker over the title, and no subheading, credit or date under
it, in the markup or as a parameter. Its default text and every value you pass
carry no em-dash and no full stop, the rules `SKILL.md` gives for everything on
screen.

## Parameters

| type | value | in CSS |
|---|---|---|
| `text` | a string; `maxLength` (default 500), `multiline` | written into every `[data-param="key"]` element |
| `font` | `"default"`, `"bundled:<file>"`, or an absolute path | `var(--key)` is a family list with fallbacks |
| `image` | `""` or an absolute path | `var(--key)` is `url(...)` or `none` |
| `number` | a number; `min`, `max`, `step` | `var(--key)` is unitless: `calc(var(--size) * 1px)` |
| `color` | `#rrggbb` | `var(--key)` |
| `bool` | true or false | `var(--key)` is 1 or 0 |
| `select` | one of `options[].value` (numbers) | `var(--key)` is the number |
| `point` | `[x, y]` | `var(--key-x)`, `var(--key-y)` |

HTML programs need no `uniform` on a parameter. A key must be a CSS name and
may not be one of the host's own (`t`, `progress`, `dur`, `w`, `h`, `rand`,
`from-center`, `fit`, or anything starting `char-`, `word-`, `line-`). A text
parameter must have an element with its `data-param`, and every other parameter
should be read somewhere (`check_program` warns about one that is not).

**Numeric parameters animate** as `fx:<key>` with `set_animation` and
`add_keyframes`, exactly as on an effect. Colours do not; animate a colour with
`@keyframes`.

A number parameter called `seed` feeds `--seed` and the per-letter `--rand`, so
the user can reshuffle a random arrangement.

**Fonts.** Never name a face in CSS directly: it exists only on the machine
that wrote it. Use a `font` parameter. `bundled:<file>` names a face every
install has: AbrilFatface-Regular.ttf, Anton-Regular.ttf,
ArchivoBlack-Regular.ttf, BebasNeue-Regular.ttf, Caveat-Bold.ttf,
Inter-Bold.ttf, Lobster-Regular.ttf, Lora-Bold.ttf, Merriweather-Bold.ttf,
Montserrat-ExtraBold.ttf, Nunito-Bold.ttf, OpenSans-SemiBold.ttf,
Oswald-Bold.ttf, Pacifico-Regular.ttf, PermanentMarker-Regular.ttf,
PlayfairDisplay-Bold.ttf, Poppins-SemiBold.ttf, Raleway-SemiBold.ttf,
Roboto-Bold.ttf, RobotoMono-Bold.ttf. These are Latin faces; Hangul falls back
to the app's default face, which is behind every family list. The one literal
family that is always present is `"Noto Sans KR"`, a variable face (weight 100
to 900) with Hangul, which is what a weight animation should use.

## What the host gives you

On the root (`.graphic-root`, which is a size container):

| variable | meaning |
|---|---|
| `--t` | program time in seconds, snapped to the frame grid |
| `--progress` | `--t / --dur`, 0 to 1 |
| `--dur` | the whole program's length in seconds |
| `--w`, `--h` | the layout box in px |
| `--seed` | the `seed` parameter, or 0 |

Size things with `100cqw` and `100cqh` (the box), never `vw`/`vh` (the editor
window, removed).

**Time.** Write ordinary CSS animations with delays. The host pauses every
animation and seeks it to the program time on every frame, so a frame is the
same in the preview and the export, and `infinite` loops work. SVG SMIL
(`<animate>`, `<set>`, `<animateTransform>`, `<animateMotion>`) is seeked the
same way. Transitions are removed: they run on the wall clock.

An exit is a delay measured back from the end:

```css
.title { animation: in .6s cubic-bezier(.2,.8,.2,1) both,
                    out .4s ease-in calc((var(--dur) - .4) * 1s) forwards; }
```

`--dur` stays the same when the user splits or trims the clip, so an exit plays
at the end of the program, not at a cut.

## Splitting into letters, words and lines

`data-split="chars"`, `"words"`, `"lines"`, or several (`"words chars"`) on an
element wraps its text, after any `data-param` text is filled in:

```html
<h1 data-param="title" data-split="chars"></h1>
```

becomes `.word` spans (inline-block, never broken inside) holding `.char`
spans, with the spaces left between the words. Each carries custom properties:

| variable | on | meaning |
|---|---|---|
| `--char-index`, `--char-count` | `.char` / the split element | the letter's place, and how many |
| `--char-in-word` | `.char` | its place inside its word |
| `--word-index`, `--word-count` | `.word` / the split element | the same for words |
| `--line-index`, `--line-count` | `.line` / the split element | lines, measured after layout (`lines`) |
| `--rand` | every unit | a stable random 0 to 1, from the program and `seed` |
| `--from-center` | every unit | 0 at the middle, 1 at the ends |

Custom properties inherit, so a `.char` can read its word's `--word-index`.
Letters are grapheme clusters: an emoji or a composed Hangul syllable is one
letter. Words in a joining script (Arabic and the like) are not split into
letters, because separate spans would break the joins.

A letter is an inline-block, which loses the kerning between letters. Split to
`words` when kerning matters more than per-letter motion.

```css
.char { display: inline-block;
        animation: rise .5s cubic-bezier(.2,.8,.2,1) both;
        animation-delay: calc(var(--char-index) * 40ms); }
@keyframes rise { from { transform: translateY(60%); opacity: 0 } }
```

## Fitting text to its box

`data-fit` on an element makes the host find the largest scale at which its
content stays inside it, and set that as `--fit` on the element. Multiply a
size by it:

```html
<h1 class="title" data-param="title" data-fit></h1>
```
```css
.title { width: 100%; white-space: nowrap;
         font-size: calc(var(--size) * var(--fit, 1) * 1px); }
```

`data-fit` (or `data-fit="width"`) fits the width, `data-fit="box"` the width
and the height. It only shrinks unless `data-fit-max` allows growth
(`data-fit-max="3"`, up to 8). The element needs a definite size of its own
(`width: 100%`, a block) for there to be something to fit. The fit is measured
on the resting layout, with animations and transforms off, so it does not
change while letters move; it is redone when the text, the box, a value or a
font changes.

## What is allowed

HTML: the common text and layout elements (`div span p h1`-`h6 strong em b i u s
small sub sup br ul ol li table figure blockquote pre code img ruby rt rp mark
abbr q cite time wbr bdi bdo del ins section article header footer`), and SVG
with gradients, patterns, clip paths, masks, `textPath`, `use`, markers, SMIL,
and filters including `feTurbulence`, `feDisplacementMap`, `feMorphology`,
`feComponentTransfer`, `feConvolveMatrix`, `feDropShadow` and the lighting
filters. Attributes: `class id style title dir lang role`, `data-*`, and the
SVG presentation and geometry attributes. A tag with a hyphen in its name is
removed.

CSS: everything visual, plus `@keyframes`, `@property`, `@supports`, `@layer`,
`@container`, `@counter-style`, `@font-feature-values`, `@scope`, and `@media`
that does not ask about the window or the machine. `attr()` works (for a glitch
that duplicates its text with `content: attr(data-text)`).

`url()` may only be `#id` (a filter, clip path, mask or gradient in this
graphic) or `asset:<name>` (a file the program ships). An `href` on `use`,
`textPath`, `mpath` or `feImage` is a `#id` too.

Removed, with a warning: scripts, event attributes, `<style>` and `<link>`,
`@import`, `@font-face`, any URL that is not one of the two forms above,
`transition`, `animation-timeline`, `animation-play-state`, `random()`, viewport
units, `@media` on width, height, resolution or `prefers-*`, and system colours
(`Canvas`, `Highlight` and the like). Each of those either fetches something or
renders differently on another machine.

## Recipes

| want | how |
|---|---|
| a wave through the letters | `.char { animation: bob 1.2s ease-in-out infinite; animation-delay: calc(var(--char-index) * -80ms) }` |
| random order | `animation-delay: calc(var(--rand) * 600ms)` |
| from the middle out | `animation-delay: calc(var(--from-center) * 400ms)` |
| 3D flip | `.word { perspective: 600px } .char { transform-origin: 50% 100%; animation: flip .6s both } @keyframes flip { from { transform: rotateX(-90deg) } }` |
| a colour per letter | `color: hsl(calc(var(--char-index) * 24 + var(--t) * 90) 90% 60%)` |
| a moving gradient in the letters | `@property --a { syntax: "<angle>"; inherits: false; initial-value: 0deg }`, `background: linear-gradient(var(--a), ...)`, `background-clip: text; color: transparent`, animate `--a` |
| a picture in the letters | an `image` parameter, `background: var(--photo) center / cover; background-clip: text; color: transparent` |
| two outlines | `-webkit-text-stroke` with `paint-order: stroke fill`, plus a `text-shadow` ring, or an SVG `<text>` drawn twice with different `stroke-width` |
| a long shadow | many `text-shadow` layers, `1px 1px`, `2px 2px`, ... |
| text on a curve | SVG `<path id="p">` and `<text><textPath href="#p" startOffset="0%">`, with `<animate attributeName="startOffset">` |
| vertical writing | `writing-mode: vertical-rl; text-orientation: upright`, `text-combine-upright: all` on short digit runs |
| ruby | `<ruby>漢字<rt data-param="reading"></rt></ruby>` |
| a weight wave | `font-family: "Noto Sans KR"`, animate `font-variation-settings: "wght" 100` to `"wght" 900` per letter |
| liquid distortion | SVG `<filter id="f"><feTurbulence ...><animate attributeName="baseFrequency" .../></feTurbulence><feDisplacementMap in="SourceGraphic" scale="..."/></filter>` and `filter: url(#f)` |
| a wipe | `@property --p { syntax: "<percentage>"; ... }`, `mask-image: linear-gradient(90deg, #000 var(--p), transparent calc(var(--p) + 10%))` |
| drawing the strokes | SVG `<text>` with `stroke-dasharray` and an animated `stroke-dashoffset`, then fill |
| a counter | `@property --n { syntax: "<integer>"; inherits: false; initial-value: 0 }`, `counter-reset: n var(--n)`, `::after { content: counter(n) }`, animate `--n` |
| Korean line breaks | `word-break: keep-all` always; `text-wrap: balance` on titles |
| justified text | `text-align: justify; hyphens: auto` with `lang` on the element |

## Gotchas

- **A `data-param` element's children are replaced by the text.** Put the slot
  on the innermost element. Text on a path with an animated offset is
  `<textPath href="#p"><animate .../><tspan data-param="title"></tspan></textPath>`,
  not `data-param` on the `textPath`, or the `<animate>` goes with the old text.
- **A parameter reaches CSS, never an attribute.** `var()` works only where CSS
  is read, so a filter primitive's `scale` or `radius` attribute cannot follow a
  parameter. Where an attribute has a CSS property (`stroke-width`, `fill`,
  `flood-color`, `flood-opacity`, `stop-color`), set that from CSS instead. For
  the strength of a displacement, keep `scale` fixed and blend the noise towards
  50% grey with an `feFlood` whose `flood-opacity` is `calc(1 - var(--amount))`:
  grey displaces nothing. The `liquid` preset does exactly this.
- **Every value you read is unitless.** `calc(var(--size) * 1px)`, not
  `var(--size)px`.

## GLSL graphics

`render: { "type": "shader", "fragment": "..." }` draws the whole box from a
fragment shader with the entry point

```glsl
vec4 graphic(vec2 uv)   // uv 0..1, y up; return straight (unpremultiplied) RGBA
```

The host declares `time` (seconds), `progress` (0 to 1), `duration` (seconds)
and `resolution` (px); declare a `uniform` for each parameter yourself and name
it in the parameter's `uniform` field (`number` is a `float`, `color` a `vec3`,
`point` a `vec2`, `bool` and `select` a `float`). GLSL graphics take only those
five parameter types, and land behind the picture as backgrounds.

## Checking it

`check_program({ program, renderAtMs: [...], box, params })` validates, compiles
a shader, and with `renderAtMs` draws the graphic alone at those moments (up to
six) over a checkerboard and returns the PNG's path. Errors and warnings carry
the line in your own source. Look at the strip after every change: a word
wrapping early, a letter clipped by too little `bleed`, or an exit that never
plays are obvious there and nowhere else.
