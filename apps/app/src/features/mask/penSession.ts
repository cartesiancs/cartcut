/**
 * The pen tool's state machine, as pure data.
 *
 * `previewCanvas` is a dispatcher over this and nothing more: it converts a
 * `MouseEvent` into an element-local point and asks what should happen. That
 * split is the same one `preview/hitTest.ts` and `preview/dragMath.ts` already
 * make, and it exists because this codebase has no DOM test environment — a
 * state machine living inside a Lit component would be untestable, and the pen
 * is the part of this feature with the most cases to get wrong.
 *
 * ## Element-local pixels, not world and not view
 *
 * A session holds its nodes in the **clip's own local space**, converted on the
 * way in. That is what makes zooming, panning and scrubbing free: none of them
 * change where a node sits on the picture, so none of them need to touch the
 * session. It also means a node keeps its place when the clip is moved,
 * rotated or scaled mid-draw, which a world-space session would not.
 *
 * ## One gesture, one undo step
 *
 * Nothing here writes to the document. The session accumulates, and the
 * component commits **once**, when the path closes — so a drawn mask is one
 * undo step, and an undo pressed halfway through a stroke cannot desynchronise
 * the session from a document it has not touched. The shape tool
 * (`previewCanvas.addShapePoint`) does the opposite, appending a point to a
 * live element on every click, and leaves an orphan element behind whenever the
 * user changes their mind.
 */

import type { MaskNode } from "../../@types/timeline";
import { boundsOf } from "./geometry";
import { MIN_PEN_NODES } from "./maskShape";

export type PenPoint = { x: number; y: number };

export type PenSession = {
  /** The clip being masked, fixed for the life of the session. */
  elementId: string;
  /** Committed nodes, anchors in element-local pixels, handles as offsets. */
  nodes: MaskNode[];
  /**
   * Index of the node whose handles are being dragged out, or `-1`.
   *
   * A click makes a corner and a drag makes a curve, which is the Illustrator
   * and Figma convention and the distinction `round.ts` later reads to decide
   * what round-corners may touch.
   */
  dragging: number;
  /** Live pointer, for the rubber-band segment. `null` before the first move. */
  hover: PenPoint | null;
};

/**
 * What the caller should do next.
 *
 * `"none"` is distinct from an unchanged session on purpose: the component
 * repaints on `"update"` and does not on `"none"`, so an ignored duplicate
 * click costs no frame.
 */
export type PenAction =
  | { kind: "none" }
  | { kind: "update"; session: PenSession }
  | { kind: "commit"; session: PenSession }
  | { kind: "cancel" };

/** Two clicks closer than this are the same click. In element-local pixels. */
const DUPLICATE_EPSILON_PX = 0.5;

/** Below this the drawn path has no extent on an axis and cannot be framed. */
const MIN_EXTENT_PX = 1e-6;

export function penBegin(elementId: string): PenSession {
  return { elementId, nodes: [], dragging: -1, hover: null };
}

function distance(a: PenPoint, b: PenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function anchorOf(node: MaskNode): PenPoint {
  return { x: node.p[0], y: node.p[1] };
}

/**
 * Whether a click at `point` would close the path.
 *
 * Only once there are enough nodes to enclose something: clicking the first
 * node again after placing just two would otherwise "close" a line segment,
 * and the commit would decline, leaving the user with a tool that looked like
 * it had done something and had not.
 *
 * `grabRadiusPx` is a screen distance the caller has already divided by the
 * world scale, the same way `preview/hitTest.ts` sizes its handle bands — a
 * grab target is a property of the pointer, not of the artwork.
 */
export function penClosesAt(
  session: PenSession,
  point: PenPoint,
  grabRadiusPx: number,
): boolean {
  if (session.nodes.length < MIN_PEN_NODES) {
    return false;
  }
  return distance(anchorOf(session.nodes[0]), point) <= grabRadiusPx;
}

/**
 * A press at `point`.
 *
 * Either closes the path — committing — or adds a corner and arms it for a
 * drag. A press within `DUPLICATE_EPSILON_PX` of the node just placed is
 * ignored, because that is a double click or a hand tremor rather than two
 * vertices, and a zero-length edge would make `round.ts` divide by its length.
 */
export function penDown(
  session: PenSession,
  point: PenPoint,
  grabRadiusPx: number,
): PenAction {
  if (penClosesAt(session, point, grabRadiusPx)) {
    return { kind: "commit", session: { ...session, dragging: -1, hover: null } };
  }

  const last = session.nodes[session.nodes.length - 1];
  if (last != null && distance(anchorOf(last), point) <= DUPLICATE_EPSILON_PX) {
    return { kind: "none" };
  }

  const nodes = [...session.nodes, { p: [point.x, point.y] } as MaskNode];
  return {
    kind: "update",
    session: { ...session, nodes, dragging: nodes.length - 1, hover: point },
  };
}

/**
 * The pointer moving, with or without a button down.
 *
 * While a node is armed this pulls its handles out **mirrored** — the outgoing
 * one toward the pointer and the incoming one exactly opposite — which is what
 * makes the curve pass smoothly through the anchor. Releasing without having
 * moved leaves both handles absent, so the node is still a corner: the
 * distinction is drawn by whether the pointer moved, not by which button was
 * used.
 */
export function penMove(session: PenSession, point: PenPoint): PenAction {
  if (session.dragging < 0) {
    if (
      session.hover != null &&
      session.hover.x === point.x &&
      session.hover.y === point.y
    ) {
      return { kind: "none" };
    }
    return { kind: "update", session: { ...session, hover: point } };
  }

  const index = session.dragging;
  const anchor = anchorOf(session.nodes[index]);
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;

  const nodes = session.nodes.map((node, at) => {
    if (at !== index) {
      return node;
    }
    if (Math.abs(dx) < DUPLICATE_EPSILON_PX && Math.abs(dy) < DUPLICATE_EPSILON_PX) {
      // Still a corner. Rebuilt rather than returned as-is so a node that had
      // handles from an earlier drag of the same press loses them again when
      // the pointer comes back to the anchor.
      return { p: [node.p[0], node.p[1]] } as MaskNode;
    }
    return {
      p: [node.p[0], node.p[1]],
      cs: [-dx, -dy],
      ce: [dx, dy],
    } as MaskNode;
  });

  return { kind: "update", session: { ...session, nodes, hover: point } };
}

/** The button coming up. Disarms the node; the path stays open. */
export function penUp(session: PenSession): PenAction {
  if (session.dragging < 0) {
    return { kind: "none" };
  }
  return { kind: "update", session: { ...session, dragging: -1 } };
}

/**
 * Key codes the pen consumes while a session is live.
 *
 * The component installs a **capture-phase** listener for exactly these, so
 * they reach the pen before `elementTimelineCanvas._handleKeydown` — which
 * would otherwise delete the clip being masked on Backspace and cancel an
 * unrelated timeline gesture on Escape.
 *
 * Arrow keys are deliberately absent. They are inert in any non-pointer tool
 * already, via the `cursorType` guards in `stepCursor` and
 * `moveSelectionByTrack`, and that is a better place for it: a modal tool
 * should not have to enumerate every binding it is not using.
 *
 * `Cmd+Z` is absent for a different reason. The session writes nothing until it
 * commits, so an undo cannot contradict it — the document it would roll back
 * does not yet contain the mask being drawn. The session survives, and only the
 * target clip disappearing ends it.
 */
export const PEN_KEY_CODES: readonly string[] = [
  "Escape",
  "Enter",
  "NumpadEnter",
  "Backspace",
  "Delete",
];

export function penCapturesKey(code: string): boolean {
  return PEN_KEY_CODES.includes(code);
}

/**
 * A keystroke the pen owns.
 *
 * Backspace on an empty session **cancels** rather than doing nothing, so the
 * key always has an effect and a user who over-deletes ends up with the tool
 * off rather than with an invisible empty session still swallowing their
 * Backspaces.
 */
export function penKey(session: PenSession, code: string): PenAction {
  switch (code) {
    case "Escape":
      return { kind: "cancel" };
    case "Enter":
    case "NumpadEnter":
      return session.nodes.length >= MIN_PEN_NODES
        ? { kind: "commit", session: { ...session, dragging: -1, hover: null } }
        : { kind: "none" };
    case "Backspace":
    case "Delete": {
      if (session.nodes.length === 0) {
        return { kind: "cancel" };
      }
      return {
        kind: "update",
        session: {
          ...session,
          nodes: session.nodes.slice(0, -1),
          dragging: -1,
        },
      };
    }
    default:
      return { kind: "none" };
  }
}

/** What `penCommit` produces: the mask fields a drawn path implies. */
export type PenCommit = {
  location: { x: number; y: number };
  size: { width: number; height: number };
  path: MaskNode[];
};

/**
 * Frame the drawn path and express it in the unit square.
 *
 * The path's own bounding box becomes the mask's `location` and `size`, and the
 * nodes are re-expressed relative to it. That is what makes a pen mask behave
 * like the three built-in shapes from then on: the sidebar's position, size and
 * rotation fields — and their keyframes — move the whole drawing, because it
 * occupies the same unit square a rectangle or a star would.
 *
 * Framing happens **once**, here. Editing a node later moves it within the box
 * rather than reframing, so a handle pulled outside the unit square stays
 * outside it and the mask does not creep every time it is touched.
 *
 * `null` when the path cannot enclose anything or the element has no extent —
 * the same decline `setClipMaskPath` makes, so the two agree about what a
 * usable path is.
 */
export function penCommit(
  session: PenSession,
  box: { width: number; height: number },
): PenCommit | null {
  if (session.nodes.length < MIN_PEN_NODES) {
    return null;
  }
  if (!(box.width > 0) || !(box.height > 0)) {
    return null;
  }

  const bounds = boundsOf(session.nodes);
  if (bounds == null) {
    return null;
  }

  const rawWidth = bounds.maxX - bounds.minX;
  const rawHeight = bounds.maxY - bounds.minY;
  // A path with no extent on one axis — three collinear clicks — still has to
  // produce a usable box, or the normalisation below divides by zero and every
  // node lands at NaN. One pixel is arbitrary and unreachable in practice; what
  // matters is that it is not zero.
  const width = rawWidth > MIN_EXTENT_PX ? rawWidth : 1;
  const height = rawHeight > MIN_EXTENT_PX ? rawHeight : 1;
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;

  return {
    location: { x: (centreX / box.width) * 100, y: (centreY / box.height) * 100 },
    size: { width: (width / box.width) * 100, height: (height / box.height) * 100 },
    path: session.nodes.map((node) => {
      const out: MaskNode = {
        p: [(node.p[0] - centreX) / width, (node.p[1] - centreY) / height],
      };
      if (node.cs !== undefined) {
        out.cs = [node.cs[0] / width, node.cs[1] / height];
      }
      if (node.ce !== undefined) {
        out.ce = [node.ce[0] / width, node.ce[1] / height];
      }
      return out;
    }),
  };
}
