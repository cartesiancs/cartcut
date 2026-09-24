/**
 * A border and a drop shadow, across a selection.
 *
 * `update_clip` can already write every one of these fields, one clip at a
 * time — that is what the leaf paths in `writable.ts` are for. This exists
 * because the thing people actually do with a border is put the same one on
 * twelve cards, and twelve `update_clip` calls is twelve undo steps.
 *
 * The arguments are **flat** rather than two nested objects, for the reason
 * `set_shape` gives for `arcStart`/`arcSweep`: an agent changing a shadow's
 * blur should not have to restate its colour and offset. Anything left out is
 * left alone.
 *
 * `enable` defaults to true when any field of that decoration is named. Asking
 * for a 4px border and being told it wrote a disabled one would be a trap, and
 * the explicit `false` is still there for switching one off.
 */

import type {
  ClipShadow,
  ClipStroke,
  StrokeAlignment,
  TimelineElement,
} from "../../../@types/timeline";
import { setIn } from "../../../utils/immutable";
import {
  DECORATABLE_FILETYPES,
  isDecoratable,
  shadowOf,
  strokeOf,
} from "../../renderer/decoration";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

type DecorationArgs = {
  elementIds: string[];
  strokeEnable?: boolean;
  strokeWidth?: number;
  strokeColor?: string;
  strokeOpacity?: number;
  strokeAlign?: StrokeAlignment;
  shadowEnable?: boolean;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOpacity?: number;
};

/** What a clip gets when it has never carried one. */
const STROKE_DEFAULTS: ClipStroke = {
  enable: true,
  width: 2,
  color: "#000000",
  opacity: 100,
  align: "center",
};

const SHADOW_DEFAULTS: ClipShadow = {
  enable: true,
  offsetX: 0,
  offsetY: 8,
  blur: 16,
  color: "#000000",
  opacity: 40,
};

/**
 * The stored decoration, whatever shape it is in.
 *
 * `strokeOf`/`shadowOf` answer `null` for one that is switched off or that
 * would paint nothing, which is right for the renderer and wrong here: a patch
 * turning a disabled border back on must not lose the width it had. So the raw
 * field is read, and the resolvers are used only to report the result.
 */
function storedOr<T>(element: TimelineElement, key: string, fallback: T): T {
  const raw = (element as any)[key];
  return raw != null && typeof raw === "object" && !Array.isArray(raw)
    ? ({ ...fallback, ...raw } as T)
    : ({ ...fallback } as T);
}

function anyNamed(args: DecorationArgs, prefix: "stroke" | "shadow"): boolean {
  return Object.keys(args).some(
    (key) => key.startsWith(prefix) && (args as any)[key] !== undefined,
  );
}

registerCommands({
  set_clip_decoration: (args: DecorationArgs) => {
    const doc = currentDoc();
    const ids = args.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_clip_decoration needs at least one id in `elementIds`.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isDecoratable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${DECORATABLE_FILETYPES.join(", ")} clips carry a border and a shadow; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}. ` +
          `A text clip has its own pair, which strokes the letters rather than the box: ` +
          `use update_clip with options.outline and options.shadow.`,
      );
    }

    const touchesStroke = anyNamed(args, "stroke");
    const touchesShadow = anyNamed(args, "shadow");
    if (!touchesStroke && !touchesShadow) {
      throw new Error(
        "set_clip_decoration needs at least one stroke* or shadow* field.",
      );
    }

    const result = commit((d: TimelineDocument) => {
      const elements = { ...d.elements };
      let changed = false;

      for (const id of ids) {
        const before = elements[id];
        let updated = before;

        if (touchesStroke) {
          const next = storedOr<ClipStroke>(before, "stroke", STROKE_DEFAULTS);
          // Naming any field turns it on, unless `false` says otherwise. A tool
          // that wrote a disabled border because nobody said "enable" would be
          // reporting success for an edit with no visible effect.
          next.enable = args.strokeEnable ?? true;
          if (args.strokeWidth !== undefined) next.width = args.strokeWidth;
          if (args.strokeColor !== undefined) next.color = args.strokeColor;
          if (args.strokeOpacity !== undefined) next.opacity = args.strokeOpacity;
          if (args.strokeAlign !== undefined) next.align = args.strokeAlign;
          updated = setIn(updated, ["stroke"], next) as TimelineElement;
        }

        if (touchesShadow) {
          const next = storedOr<ClipShadow>(before, "shadow", SHADOW_DEFAULTS);
          next.enable = args.shadowEnable ?? true;
          if (args.shadowOffsetX !== undefined) next.offsetX = args.shadowOffsetX;
          if (args.shadowOffsetY !== undefined) next.offsetY = args.shadowOffsetY;
          if (args.shadowBlur !== undefined) next.blur = args.shadowBlur;
          if (args.shadowColor !== undefined) next.color = args.shadowColor;
          if (args.shadowOpacity !== undefined) next.opacity = args.shadowOpacity;
          updated = setIn(updated, ["shadow"], next) as TimelineElement;
        }

        if (updated !== before) {
          elements[id] = updated;
          changed = true;
        }
      }

      // Identity, so `withCheckpoint` records no step for a decoration the
      // clips already carry.
      return changed ? { ...d, elements } : d;
    }, "Those clips already carry that border and shadow.");

    const after = currentDoc();
    return {
      ...result,
      // Through the read guards, so the answer is what the renderer will
      // actually draw rather than what was stored: a border of zero width
      // reports as absent, which is what it looks like.
      decoration: ids.map((id) => ({
        elementId: id,
        stroke: strokeOf(after.elements[id]),
        shadow: shadowOf(after.elements[id]),
      })),
    };
  },
});
