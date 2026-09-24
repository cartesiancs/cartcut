/**
 * One property driven by another property's value.
 *
 * This is where an expression language would go, and it is deliberately **data
 * rather than code** — see `PropertyLink` in `@types/timeline.ts` for why, and
 * for what is given up. What a link says is: take that element's value for that
 * property, add an offset, and map it through a piecewise curve.
 *
 * Three rules hold the module together, and all three are about *not throwing*.
 * `resolveLinks` runs inside the paint loop, once per element per frame, on
 * whatever is in the project file.
 *
 * - **A cycle resolves to the static value, silently.** Not an error, not a
 *   blank frame: a link that eventually points back at itself stops at the
 *   revisit and the property falls back to what it would have been. The guard
 *   is a visiting set keyed by `"id:property"`, so two links on one element can
 *   read each other's *unlinked* value without either being called a cycle.
 * - **A missing or mistyped source is no link at all**, the rule
 *   `hierarchy.ts#parentOf` follows for a dangling `parentId`: consumers need
 *   no guard of their own, and an unrepaired document still draws.
 * - **Depth is capped.** `MAX_LINK_DEPTH` is 4 for the reason
 *   `MAX_GROUP_DEPTH` is 8: the graph is walked per element per frame, and a
 *   chain nobody can see is not worth paying for.
 *
 * DOM-free and store-free, like the rest of `features/animation/`: it takes the
 * element map and a cursor and runs under `environment: "node"`.
 */

import type {
  AnimatableProperty,
  LinkableProperty,
  PropertyLink,
  Timeline,
} from "../../@types/timeline";
import { LINKABLE_PROPERTIES } from "../../@types/timeline";
import { easeAt, resolveEasing } from "./easing";

/** How far a link may reach through other links. */
export const MAX_LINK_DEPTH = 4;

/** Most stops a map may have. Beyond this it is a curve, not a mapping. */
export const MAX_LINK_STOPS = 16;

const LINKABLE = new Set<string>(LINKABLE_PROPERTIES);

export function isLinkableProperty(
  property: unknown,
): property is LinkableProperty {
  return typeof property === "string" && LINKABLE.has(property);
}

/**
 * The value a link's driven property resolves to, keyed by property.
 *
 * `position` is the one pair: a link on it drives whichever lane it names and
 * leaves the other alone, because "x follows the parent's rotation and y stays
 * put" is a thing people mean. The sampler reads each lane independently
 * anyway, so nothing else has to know.
 */
export type SampleOverrides = Partial<{
  positionX: number;
  positionY: number;
  opacity: number;
  scale: number;
  rotation: number;
}>;

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readStops(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_LINK_STOPS) {
    return null;
  }
  const out: number[] = [];
  for (const entry of value) {
    const n = finite(entry);
    if (n == null) {
      return null;
    }
    out.push(n);
  }
  return out;
}

/**
 * The link stored on a property, normalised, or `null`.
 *
 * The read guard. It never throws, and it refuses anything it cannot evaluate
 * rather than repairing it: an `in` that is not ascending has no single answer
 * for a value inside the fold, and guessing one would be a picture nobody
 * asked for.
 */
export function linkOf(
  element: unknown,
  property: LinkableProperty,
): PropertyLink | null {
  const links = (element as { link?: unknown } | null | undefined)?.link;
  if (links == null || typeof links !== "object" || Array.isArray(links)) {
    return null;
  }
  return normalizeLink((links as Record<string, unknown>)[property]);
}

/** Shared by the read guard and the write validator. */
function normalizeLink(raw: unknown): PropertyLink | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;

  const from = source.from as Record<string, unknown> | undefined;
  if (from == null || typeof from !== "object") {
    return null;
  }
  const elementId = from.elementId;
  const property = from.property;
  if (typeof elementId !== "string" || elementId === "") {
    return null;
  }
  if (typeof property !== "string" || property === "") {
    return null;
  }

  const input = readStops(source.in);
  const output = readStops(source.out);
  if (input == null || output == null || input.length !== output.length) {
    return null;
  }
  // Strictly ascending: a repeated stop is a division by zero and a descending
  // one has two answers in the fold.
  for (let i = 1; i < input.length; i += 1) {
    if (!(input[i] > input[i - 1])) {
      return null;
    }
  }

  const link: PropertyLink = {
    from: {
      elementId,
      property: property as AnimatableProperty,
      ...(from.lane === "y" ? { lane: "y" as const } : {}),
    },
    in: input,
    out: output,
  };

  if (typeof source.easing === "string" && resolveEasing(source.easing) != null) {
    link.easing = source.easing;
  }
  if (source.extend === "extrapolate") {
    link.extend = "extrapolate";
  }
  const offset = finite(source.offset);
  if (offset != null && offset !== 0) {
    link.offset = offset;
  }

  return link;
}

/**
 * The write validator, the strict twin of `linkOf`.
 *
 * Same normalisation, different contract: this runs once, where a link arrives,
 * and `null` is the caller's signal to refuse with a message rather than store
 * something the reader would ignore.
 */
export function coerceLink(value: unknown): PropertyLink | null {
  return normalizeLink(value);
}

/**
 * Map a source value through a link's curve.
 *
 * Exported because it is the whole of what a link *means*, and a caller
 * checking its numbers should be able to ask without building a document.
 */
export function mapThrough(link: PropertyLink, sourceValue: number): number {
  const x = sourceValue + (link.offset ?? 0);
  const { in: input, out: output } = link;
  const last = input.length - 1;

  const curve = link.easing == null ? null : resolveEasing(link.easing);
  const shape = (t: number) => (curve == null ? t : easeAt(curve, t));

  if (x <= input[0]) {
    if (link.extend !== "extrapolate") {
      return output[0];
    }
    // Along the first segment's slope, backwards. The easing is not applied
    // outside the stops: it describes the shape *between* two of them, and
    // continuing it past the end is not defined.
    const span = input[1] - input[0];
    return output[0] + ((output[1] - output[0]) / span) * (x - input[0]);
  }

  if (x >= input[last]) {
    if (link.extend !== "extrapolate") {
      return output[last];
    }
    const span = input[last] - input[last - 1];
    return (
      output[last] +
      ((output[last] - output[last - 1]) / span) * (x - input[last])
    );
  }

  for (let i = 1; i <= last; i += 1) {
    if (x <= input[i]) {
      const t = (x - input[i - 1]) / (input[i] - input[i - 1]);
      return output[i - 1] + (output[i] - output[i - 1]) * shape(t);
    }
  }

  // Unreachable: the two branches above cover everything outside `[first,
  // last]` and the loop covers everything inside it. Answering the last stop
  // rather than `NaN` keeps the never-throws contract if it ever is reached.
  return output[last];
}

/**
 * The value a source property has at a cursor, before any link of its own.
 *
 * Deliberately the *unlinked* value, which is what stops a pair of links from
 * being mutually recursive in the common case — a card reading the null's
 * rotation does not care whether the null's rotation is itself linked, and
 * `resolveLinks` handles the chain separately with its own guard.
 */
function staticSampleOf(
  element: any,
  property: string,
  lane: "x" | "y",
  cursor: number,
): number | null {
  if (element == null) {
    return null;
  }

  const fallback = staticFieldOf(element, property, lane);
  if (fallback == null) {
    return null;
  }

  const track = element.animation?.[property];
  if (track == null || track.isActivate !== true) {
    return fallback;
  }
  const baked = track[lane === "y" ? "ay" : "ax"];
  if (!Array.isArray(baked) || baked.length === 0) {
    return fallback;
  }

  const start = finite(element.startTime);
  if (start == null || cursor < start) {
    return fallback;
  }
  return sampleBakedLane(baked, cursor - start, fallback);
}

/** The element's own field for a property, or `null` when it has none. */
function staticFieldOf(
  element: any,
  property: string,
  lane: "x" | "y",
): number | null {
  switch (property) {
    case "position":
      return finite(lane === "y" ? element.location?.y : element.location?.x) ?? 0;
    case "opacity":
      return finite(element.opacity) ?? 100;
    case "scale":
      return finite(element.scale) ?? 10;
    case "rotation":
      return finite(element.rotation) ?? 0;
    case "size":
      return finite(lane === "y" ? element.height : element.width) ?? 0;
    case "volumeDb":
      return finite(element.volumeDb) ?? 0;
    case "intensity":
      return finite(element.intensity) ?? 100;
    default:
      // A `fx:<key>` parameter, or a mask field. Read from where it lives, and
      // answer `null` for anything with no static value at all — which reads
      // as "no link", not as zero.
      if (property.startsWith("fx:")) {
        return finite(element.params?.[property.slice(3)]);
      }
      return null;
  }
}

/**
 * Nearest-sample lookup over a baked lane.
 *
 * The same rule `keyframes.ts#sampleBaked` states — snap, never interpolate —
 * restated here rather than imported so this module stays free of the baker's
 * much larger surface. Both read `[timeMs, value]` pairs in ascending time.
 */
function sampleBakedLane(
  baked: number[][],
  atMs: number,
  fallback: number,
): number {
  let lo = 0;
  let hi = baked.length - 1;
  if (!(baked[0]?.length >= 2)) {
    return fallback;
  }
  if (atMs <= baked[0][0]) {
    return baked[0][1];
  }
  if (atMs >= baked[hi][0]) {
    return baked[hi][1];
  }

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (baked[mid][0] <= atMs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Ties to the earlier sample, as `sampleBaked` does.
  return atMs - baked[lo][0] <= baked[hi][0] - atMs ? baked[lo][1] : baked[hi][1];
}

/**
 * Every link on one element, resolved at a cursor.
 *
 * `null` when the element has none, which is the overwhelmingly common answer
 * and costs one property read.
 */
export function resolveLinks(
  elements: Timeline,
  elementId: string,
  cursor: number,
): SampleOverrides | null {
  const element = (elements as any)?.[elementId];
  const links = element?.link;
  if (links == null || typeof links !== "object" || Array.isArray(links)) {
    return null;
  }

  let out: SampleOverrides | null = null;

  for (const property of LINKABLE_PROPERTIES) {
    const link = normalizeLink(links[property]);
    if (link == null) {
      continue;
    }

    const value = valueThrough(elements, elementId, property, link, cursor, new Set());
    if (value == null) {
      continue;
    }

    out = out ?? {};
    if (property === "position") {
      // Whichever lane the *driven* side means is the one the source named:
      // a link reading the parent's `rotation` into `position` has no second
      // lane to fill, so it drives the one it was pointed at and leaves the
      // other to the clip's own keyframes.
      if (link.from.lane === "y") {
        out.positionY = value;
      } else {
        out.positionX = value;
      }
    } else {
      out[property] = value;
    }
  }

  return out;
}

/** Follow one link to a number, guarding the walk. */
function valueThrough(
  elements: Timeline,
  elementId: string,
  property: string,
  link: PropertyLink,
  cursor: number,
  visiting: Set<string>,
): number | null {
  const key = `${elementId}:${property}`;
  if (visiting.has(key) || visiting.size >= MAX_LINK_DEPTH) {
    // A cycle, or a chain longer than anyone can follow. Falling back to the
    // static value is what keeps this from being a blank frame.
    return null;
  }
  visiting.add(key);

  const source = (elements as any)?.[link.from.elementId];
  if (source == null) {
    return null;
  }

  const lane = link.from.lane === "y" ? "y" : "x";
  let raw = staticSampleOf(source, link.from.property, lane, cursor);
  if (raw == null) {
    return null;
  }

  // The source may itself be driven. Following it is what makes a chain of
  // nulls work, and the visiting set is what stops it going round.
  if (isLinkableProperty(link.from.property)) {
    const onward = linkOf(source, link.from.property);
    if (onward != null) {
      const driven = valueThrough(
        elements,
        link.from.elementId,
        link.from.property,
        onward,
        cursor,
        visiting,
      );
      if (driven != null) {
        raw = driven;
      }
    }
  }

  return mapThrough(link, raw);
}
