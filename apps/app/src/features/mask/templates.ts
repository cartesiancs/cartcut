/**
 * The three built-in mask shapes, as node lists in the unit square.
 *
 * Each is authored in whatever coordinates were natural to write it in and then
 * **normalised onto `[-0.5, 0.5]²` at module load**, against the same
 * `boundsOf` the pen tool uses to frame a drawn path. That is what lets
 * `MaskType.size` mean one thing for all four shapes: 100/100 is the element
 * box, whichever shape is in it, and switching from a rectangle to a star keeps
 * the mask the same size on screen instead of shrinking it by however much
 * empty room a star's circumscribed circle happens to leave.
 *
 * Normalising against the *curve* rather than the control hull matters for the
 * heart specifically: its lobes bulge past their anchors, so hull-normalising
 * would leave it overflowing the box it claims to fill.
 *
 * Authored y-down, matching the canvas and the element's own local space.
 */

import type { MaskNode, MaskShape } from "../../@types/timeline";
import { boundsOf } from "./geometry";

/** Fit a node list to `[-0.5, 0.5]²`, preserving nothing but the shape's form. */
function normalized(nodes: MaskNode[]): MaskNode[] {
  const bounds = boundsOf(nodes);
  if (bounds == null) {
    return nodes;
  }
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  // A shape with no extent on an axis is not one of ours, but dividing by it
  // would put the whole path at NaN and take the clip with it.
  const sx = width > 1e-9 ? 1 / width : 1;
  const sy = height > 1e-9 ? 1 / height : 1;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  return nodes.map((node) => {
    const out: MaskNode = { p: [(node.p[0] - cx) * sx, (node.p[1] - cy) * sy] };
    if (node.cs !== undefined) {
      out.cs = [node.cs[0] * sx, node.cs[1] * sy];
    }
    if (node.ce !== undefined) {
      out.ce = [node.ce[0] * sx, node.ce[1] * sy];
    }
    return out;
  });
}

/** Four corners, clockwise from the top left. */
const RECTANGLE: MaskNode[] = normalized([
  { p: [-0.5, -0.5] },
  { p: [0.5, -0.5] },
  { p: [0.5, 0.5] },
  { p: [-0.5, 0.5] },
]);

/**
 * The ratio of a five-pointed star's inner radius to its outer one.
 *
 * `1/φ²`, the value at which the star's edges are collinear across each point —
 * i.e. the star inscribed in a pentagram, which is the shape everyone means by
 * "star". Anything else gives points that visibly bend.
 */
const STAR_INNER_RATIO = 1 / ((1 + Math.sqrt(5)) / 2) ** 2;

/** Ten alternating corners, first point straight up. */
const STAR: MaskNode[] = normalized(
  Array.from({ length: 10 }, (_unused, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? 0.5 : 0.5 * STAR_INNER_RATIO;
    const node: MaskNode = {
      p: [radius * Math.cos(angle), radius * Math.sin(angle)],
    };
    return node;
  }),
);

/**
 * Two lobes and a point, six anchors.
 *
 * Every node carries handles — including the two that carry zero-length ones at
 * the bottom point, where the two lobes meet the tip. That is not padding: a
 * present handle is what makes a node *not a corner*, and it is how "a heart is
 * never rounded" holds as a consequence of `round.ts`'s one rule rather than as
 * a special case named after this shape.
 */
const HEART: MaskNode[] = normalized([
  // The bottom tip. Both handles zero, so the two lobes arrive at a true point.
  { p: [0.5, 0.9], cs: [0, 0], ce: [0, 0] },
  // Left outer wall, sweeping up.
  { p: [0.05, 0.3], cs: [0, 0.25], ce: [0, -0.2] },
  // Left lobe, over the top.
  { p: [0.35, 0.05], cs: [-0.1, 0], ce: [0.1, 0] },
  // The notch between the lobes: a cusp, both handles pointing the same way.
  { p: [0.5, 0.2], cs: [0, -0.05], ce: [0, -0.05] },
  // Right lobe.
  { p: [0.65, 0.05], cs: [-0.1, 0], ce: [0.1, 0] },
  // Right outer wall, sweeping back down to the tip.
  { p: [0.95, 0.3], cs: [0, -0.2], ce: [0, 0.25] },
]);

/**
 * The unit-space nodes for a shape, or the drawn path for `pen`.
 *
 * Returns a **fresh copy** every call. The templates are module constants, and
 * handing one straight to `round.ts` or the placement step would let a caller
 * that mutated in place rewrite the shape for every clip in the project.
 *
 * `pen` with no path answers an empty list rather than falling back to a
 * rectangle. A pen mask that cannot be drawn is a pass-through, decided once by
 * `isMaskActive`, and substituting a different shape here would put a rectangle
 * on screen that the user never asked for and cannot see the source of.
 */
export function templateNodes(
  shape: MaskShape,
  path?: readonly MaskNode[],
): MaskNode[] {
  const source =
    shape === "rectangle"
      ? RECTANGLE
      : shape === "star"
        ? STAR
        : shape === "heart"
          ? HEART
          : (path ?? []);

  return source.map((node) => {
    const out: MaskNode = { p: [node.p[0], node.p[1]] };
    if (node.cs !== undefined) {
      out.cs = [node.cs[0], node.cs[1]];
    }
    if (node.ce !== undefined) {
      out.ce = [node.ce[0], node.ce[1]];
    }
    return out;
  });
}
