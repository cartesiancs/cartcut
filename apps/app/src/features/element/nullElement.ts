/**
 * The null object — an empty transform parent.
 *
 * A factory rather than a document op, for the reason `shapeElement.ts` gives:
 * the toolbar button and the agent's tool must produce the *same* element, and
 * a factory is the only shape that guarantees it. Where it lands on the
 * timeline is then `placement.ts#placeNewElement`'s job, and
 * `defaultTrackKindFor("group")` already routes it to a group row.
 *
 * ## Why this is a `group` and not a tenth filetype
 *
 * It is exactly the element `createGroup` builds. `@types/timeline.ts` already
 * describes `GroupElementType` as "a transform parent that draws nothing —
 * After Effects' null object", and the two rules that make it work are keyed on
 * that one string: `hierarchy.ts#parentOf` admits **only** a `"group"` as a
 * parent, and `isVisualTimelineElement` excludes **only** a `"group"` from the
 * paint loop. A `filetype: "null"` would have had to be added to both — and
 * missing the first detaches every child in silence, while missing the second
 * crashes the renderer on an undefined call.
 *
 * So there is one type with two ways of being born:
 *
 *   - **`createGroup`** wraps a selection. Its pivot is the selection's
 *     bounding box, because that makes the compensation each child owes a pure
 *     translation and so keeps the picture perfectly still.
 *   - **`createNullElement`** starts empty. It has nothing to keep still, so
 *     its pivot is a plain square on a point the caller chooses, and clips are
 *     attached afterwards through `groupOps.ts#setParent`.
 *
 * The `name` field is what tells them apart on the timeline bar: "Group" or
 * "Null". No schema change, and `SCHEMA_VERSION` did not move.
 */

import type { GroupElementType } from "../../@types/timeline";
import { emptyAnimation } from "../animation/keyframes";

/**
 * The pivot box, in project pixels.
 *
 * After Effects' own convention, and the number matters only in that it has to
 * be big enough to grab on the preview. It is **not a size to draw** — nothing
 * paints a null — it is the square `localMatrixOf` rotates and scales about.
 */
export const NULL_PIVOT_SIZE = 100;

/**
 * How long the bar is when the caller does not say.
 *
 * Duration gates nothing: `renderer/timeline.ts` states explicitly that a
 * group's span does not gate its children, so a null's transform answers for
 * the whole timeline whatever this is. It decides only how much bar there is to
 * aim at when setting a keyframe, so the caller should pass the project's own
 * length and this is the fallback for a caller that has none.
 */
export const NULL_DEFAULT_DURATION_MS = 10_000;

/** Default colour for the bar, shared with `createGroup`'s. */
const NULL_BAR_COLOR = "rgb(120, 110, 190)";

export type NullElementOptions = {
  /** Shown on the bar. Defaults to "Null". */
  name?: string;
  color?: string;
  /** One side of the pivot square. */
  size?: number;
  /** Where the pivot sits in project space — usually the frame's centre. */
  center?: { x: number; y: number };
  startTime?: number;
  duration?: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function createNullElement(
  options: NullElementOptions = {},
): GroupElementType {
  // A degenerate box is not worth refusing over: a zero-width pivot makes
  // `localMatrixOf` rotate about a corner, which reads to the user as a broken
  // drag rather than as bad input. Fall back instead.
  const size =
    isFiniteNumber(options.size) && options.size > 0
      ? options.size
      : NULL_PIVOT_SIZE;

  const center = options.center;
  const cx = isFiniteNumber(center?.x) ? (center as any).x : 0;
  const cy = isFiniteNumber(center?.y) ? (center as any).y : 0;

  const startTime =
    isFiniteNumber(options.startTime) && options.startTime >= 0
      ? options.startTime
      : 0;

  const duration =
    isFiniteNumber(options.duration) && options.duration > 0
      ? options.duration
      : NULL_DEFAULT_DURATION_MS;

  return {
    filetype: "group",
    name: options.name ?? "Null",
    // Both are supplied by `placeNewElement`, which picks the track and derives
    // the paint rank from it.
    trackId: "",
    priority: 0,
    localpath: "GROUP",
    blob: "",
    startTime,
    duration,
    // `localMatrixOf` pivots about `w/2, h/2`, so seating the box means backing
    // off by half of it. Getting this wrong is invisible until someone rotates
    // the null, and then everything swings about the wrong point.
    location: { x: cx - size / 2, y: cy - size / 2 },
    width: size,
    height: size,
    ratio: 1,
    opacity: 100,
    rotation: 0,
    animation: emptyAnimation("group"),
    timelineOptions: { color: options.color ?? NULL_BAR_COLOR },
  } as GroupElementType;
}
