/**
 * Holding a graphic's snapshot at program time t.
 *
 * An SVG image draws its own first frame: a CSS animation inside it is at its
 * 0% keyframe however long ago it was decoded, and so is a SMIL animation
 * (`tests/e2e/FINDINGS.md` section 11). So the snapshot carries every
 * animation already paused and started t earlier: each CSS `animation-delay`
 * shifted by `-t`, each SMIL `begin` offset likewise. The image's own engine
 * then evaluates the same keyframes at the same moment the live mount was
 * seeked to, for every property, pseudo-element and registered custom
 * property alike, with nothing copied out of computed style. Measured exact in
 * Chromium 151, Firefox 153, WebKit 26.5 and Chrome 85 to 113. DOM-free.
 */

/** Milliseconds, as short as they can be written exactly enough. */
function ms(value: number): string {
  return `${Math.round(value * 1000) / 1000}ms`;
}

/** One CSS `<time>` in ms, or `null`. */
export function cssTimeMs(token: string): number | null {
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(ms|s)\s*$/i.exec(token);
  if (match == null) {
    return null;
  }
  const value = Number(match[1]);
  return match[2].toLowerCase() === "s" ? value * 1000 : value;
}

/**
 * A computed `animation-delay` list with every entry moved `tMs` earlier.
 * `null` when an entry cannot be read, so the caller leaves the list alone
 * rather than shifting some of it.
 */
export function shiftedDelays(list: string, tMs: number): string | null {
  const entries = list.split(",");
  const out: string[] = [];
  for (const entry of entries) {
    const value = cssTimeMs(entry);
    if (value == null) {
      return null;
    }
    out.push(ms(value - tMs));
  }
  return out.join(", ");
}

/** A SMIL clock value (`2.5s`, `500ms`, `1.2`, `0:01.5`, `00:00:02`) in ms, or `null`. */
export function smilClockMs(text: string): number | null {
  const value = text.trim();
  const count = /^(\d+(?:\.\d+)?|\.\d+)(h|min|s|ms)?$/.exec(value);
  if (count != null) {
    const n = Number(count[1]);
    switch (count[2]) {
      case "h":
        return n * 3_600_000;
      case "min":
        return n * 60_000;
      case "ms":
        return n;
      default:
        return n * 1000;
    }
  }
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (clock != null) {
    const hours = clock[1] != null ? Number(clock[1]) : 0;
    return ((hours * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000;
  }
  return null;
}

/** A SMIL offset value (an optionally signed clock value) in ms, or `null`. */
export function smilOffsetMs(text: string): number | null {
  const match = /^\s*([+-])?\s*(.+?)\s*$/.exec(text);
  if (match == null) {
    return null;
  }
  const clock = smilClockMs(match[2]);
  if (clock == null) {
    return null;
  }
  return match[1] === "-" ? -clock : clock;
}

/**
 * A SMIL `begin` list with every plain offset moved `tMs` earlier. A missing
 * `begin` means `0s`. Sync-base, event, repeat, access-key and wallclock values
 * are left as written: a sync-base follows whatever it is tied to, and events
 * never fire in an image.
 */
export function shiftSmilBegin(begin: string | null, tMs: number): string {
  if (begin == null || begin.trim() === "") {
    return ms(-tMs);
  }
  return begin
    .split(";")
    .map((item) => {
      const offset = smilOffsetMs(item);
      return offset == null ? item.trim() : ms(offset - tMs);
    })
    .join(";");
}
