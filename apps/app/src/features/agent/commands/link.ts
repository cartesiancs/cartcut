/**
 * Driving one clip's property from another's.
 *
 * This is the tool that replaces "compute every frame in Python and bake five
 * hundred keyframes". A card wheel is a null that turns and one description of
 * how a card's opacity and scale follow it; `offsets` gives each card its own
 * phase, so twelve cards are one call rather than twelve.
 *
 * The difference from baking is what happens **next**: move the null's
 * keyframes and every card follows, because the link is evaluated at draw time
 * rather than resolved once at author time.
 *
 * What it is not is an expression language. `PropertyLink` in
 * `@types/timeline.ts` says why at length; the short version is that the
 * compositor is synchronous and nothing executes inside it, and a piecewise map
 * covers the overwhelming majority of what real expressions do.
 */

import {
  LINKABLE_PROPERTIES,
  type LinkableProperty,
  type PropertyLink,
} from "../../../@types/timeline";
import { coerceLink, isLinkableProperty, linkOf } from "../../animation/link";
import {
  LINKABLE_FILETYPES,
  clearClipLink,
  isLinkable,
  linkedPropertiesOf,
  setClipLink,
  wouldCycle,
} from "../../timeline/linkOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

type LinkParams = {
  elementIds: string[];
  property: LinkableProperty;
  fromElementId: string;
  fromProperty: string;
  fromLane?: "x" | "y";
  in: number[];
  out: number[];
  easing?: string;
  extend?: "clamp" | "extrapolate";
  offsets?: number[];
};

function requireLinkable(doc: TimelineDocument, ids: string[]) {
  const wrongType = ids
    .map((id) => requireElement(doc, id))
    .filter((element) => !isLinkable(element));

  if (wrongType.length > 0) {
    throw new Error(
      `Only ${LINKABLE_FILETYPES.join(", ")} clips can carry a link; got ` +
        `${wrongType.map((element) => element.filetype).join(", ")}.`,
    );
  }
}

registerCommands({
  set_property_link: (params: LinkParams) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_property_link needs at least one id in `elementIds`.");
    }
    requireLinkable(doc, ids);

    if (!isLinkableProperty(params.property)) {
      throw new Error(
        `"${params.property}" cannot be driven by a link. ` +
          `Linkable: ${LINKABLE_PROPERTIES.join(", ")}. ` +
          `\`size\` is deliberately out — a driven box would have to reach the hit test ` +
          `and the grips as well as the picture. \`volumeDb\` is out because the audio ` +
          `envelope is built by the exporter, so a link would play and not export.`,
      );
    }

    // The source has to exist before anything else is worth checking: a link
    // to a clip that is not there resolves to nothing, and to the caller that
    // looks exactly like the feature not working.
    requireElement(doc, params.fromElementId);

    const offsets = params.offsets;
    if (offsets != null && offsets.length !== ids.length) {
      throw new Error(
        `\`offsets\` has ${offsets.length} entries and \`elementIds\` has ${ids.length}. ` +
          "One offset per clip, in the same order, or omit it for no offset.",
      );
    }

    // Built and validated per clip before the commit, so a bad shape or a
    // cycle is an error rather than a half-applied edit with an undo step
    // already recorded.
    const writes = ids.map((elementId, index) => {
      const shape: Record<string, unknown> = {
        from: {
          elementId: params.fromElementId,
          property: params.fromProperty,
          ...(params.fromLane === "y" ? { lane: "y" } : {}),
        },
        in: params.in,
        out: params.out,
      };
      if (params.easing != null) {
        shape.easing = params.easing;
      }
      if (params.extend != null) {
        shape.extend = params.extend;
      }
      if (offsets != null) {
        shape.offset = offsets[index];
      }

      const link = coerceLink(shape);
      if (link == null) {
        throw new Error(
          "That is not a link the renderer could follow. `in` must be 2 to 16 " +
            "strictly ascending numbers and `out` must have the same count. " +
            `Got in=${JSON.stringify(params.in)}, out=${JSON.stringify(params.out)}.`,
        );
      }

      if (wouldCycle(doc.elements, elementId, params.property, link.from)) {
        throw new Error(
          `Linking ${elementId}'s ${params.property} to ${params.fromElementId}'s ` +
            `${params.fromProperty} would close a cycle, so nothing could be resolved. ` +
            "Break the existing chain first with clear_property_link.",
        );
      }

      return { elementId, link };
    });

    const result = commit(
      (d: TimelineDocument) =>
        writes.reduce(
          (next, write) =>
            setClipLink(next, write.elementId, params.property, write.link),
          d,
        ),
      "Those clips are already driven exactly like that.",
    );

    const after = currentDoc();
    return {
      ...result,
      // What each clip ends up driven by, read back through the guard, so the
      // answer is what the renderer will follow rather than what was asked for.
      links: ids.map((id) => ({
        elementId: id,
        property: params.property,
        link: linkOf(after.elements[id], params.property),
      })),
      note:
        `${params.property} on those clips is now derived. Keyframes on it are kept but ` +
        "no longer drive it, and add_keyframes and update_clip will refuse it until the " +
        "link is cleared.",
    };
  },

  clear_property_link: (params: {
    elementIds: string[];
    property?: LinkableProperty;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("clear_property_link needs at least one id in `elementIds`.");
    }
    requireLinkable(doc, ids);

    if (params.property != null && !isLinkableProperty(params.property)) {
      throw new Error(
        `"${params.property}" is not a property a link can drive. ` +
          `Linkable: ${LINKABLE_PROPERTIES.join(", ")}.`,
      );
    }

    const result = commit(
      (d: TimelineDocument) =>
        ids.reduce((next, id) => clearClipLink(next, id, params.property), d),
      params.property == null
        ? "Those clips carry no links."
        : `Those clips do not drive ${params.property} from anything.`,
    );

    const after = currentDoc();
    return {
      ...result,
      // Whatever each clip still drives, so a caller clearing one property can
      // see what is left without a second read.
      remaining: ids.map((id) => ({
        elementId: id,
        linked: linkedPropertiesOf(after.elements[id]),
      })),
    };
  },
});

/** Re-exported so `animation.ts` can name the same refusal. */
export type { PropertyLink };
