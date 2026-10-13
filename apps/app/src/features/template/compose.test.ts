import { describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import {
  imageElement,
  shapeElement,
  textElement,
  transitionElement,
  videoElement,
} from "../renderer/testing";
import { resolveLinks } from "../animation/link";
import {
  bakeFills,
  composeTemplate,
  expandTemplates,
  innerKeyOf,
} from "./compose";
import type { TemplateData } from "./compose";
import { slotsOf } from "./slots";

/**
 * `composeTemplate` is the seam between what the author shipped and what the
 * user asked for. Two things it does are load-bearing and neither is obvious:
 * it **namespaces every key**, because `loadedAssetStore` caches decoders by
 * element id and two copies of one template would otherwise fight over one;
 * and it **only ever moves the trim window**, never `duration`, so a
 * replacement cannot change the template's timing.
 */

function templateDoc(over: Record<string, any> = {}): Timeline {
  return {
    bg: shapeElement({ priority: 1, startTime: 0, duration: 6000 }),
    shot: videoElement({
      priority: 2,
      startTime: 0,
      duration: 3000,
      speed: 1,
      localpath: "file:///lib/placeholder.mp4",
      sourceDuration: 3000,
      trim: { startTime: 0, endTime: 3000 },
      replaceable: { slotId: "hero" },
    }),
    title: textElement({
      priority: 3,
      startTime: 3000,
      duration: 3000,
      text: "YOUR NAME",
      replaceable: { slotId: "name" },
    }),
    ...over,
  } as Timeline;
}

function data(over: Partial<TemplateData> = {}): TemplateData {
  const elements = over.elements ?? templateDoc();
  return {
    id: "neon",
    name: "Neon Intro",
    size: { w: 1920, h: 1080 },
    durationMs: 6000,
    elements,
    slots: slotsOf(elements),
    ...over,
  };
}

function placed(over: Partial<TemplateElementType> = {}): TemplateElementType {
  return {
    filetype: "template",
    key: "tpl",
    templateId: "neon",
    name: "Neon Intro",
    fills: {},
    localpath: "TEMPLATE",
    trackId: "track-1",
    priority: 1,
    blob: "",
    startTime: 0,
    duration: 6000,
    location: { x: 0, y: 0 },
    width: 1920,
    height: 1080,
    ratio: 1,
    opacity: 100,
    rotation: 0,
    animation: videoElement().animation,
    timelineOptions: { color: "#ffffff" },
    ...over,
  } as TemplateElementType;
}

describe("namespacing", () => {
  it("prefixes every key with the outer element's id", () => {
    const composed = composeTemplate(data(), "outer", placed());
    expect(Object.keys(composed).sort()).toEqual([
      "outer::bg",
      "outer::shot",
      "outer::title",
    ]);
  });

  it("rewrites each element's own key field to match its map id", () => {
    const composed = composeTemplate(data(), "outer", placed());
    for (const [id, element] of Object.entries(composed)) {
      expect(element.key).toBe(id);
    }
  });

  it("keeps two instances of one template apart", () => {
    // The reason namespacing exists: `loadedAssetStore` keys video decoders by
    // element id, so a shared key would make two copies of one template seek
    // each other's decoder.
    const a = composeTemplate(data(), "first", placed());
    const b = composeTemplate(data(), "second", placed());
    for (const key of Object.keys(a)) {
      expect(Object.keys(b)).not.toContain(key);
    }
  });

  it("carries parentId into the namespace with everything else", () => {
    const composed = composeTemplate(
      data({
        elements: {
          g: { ...shapeElement(), filetype: "group", name: "G" },
          child: imageElement({ parentId: "g" }),
        } as unknown as Timeline,
      }),
      "outer",
      placed(),
    );
    expect((composed["outer::child"] as any).parentId).toBe("outer::g");
  });

  it("leaves a parentId naming nothing alone rather than minting a dangling one", () => {
    const composed = composeTemplate(
      data({
        elements: { child: imageElement({ parentId: "ghost" }) } as Timeline,
      }),
      "outer",
      placed(),
    );
    expect((composed["outer::child"] as any).parentId).toBeUndefined();
  });

  it("carries a property link's source into the namespace", () => {
    // Left on its bare key, the link found nothing in the composed map and
    // fell back to the static value: authored in the template's own project,
    // it worked; placed, it silently did not.
    const composed = composeTemplate(
      data({
        elements: {
          spin: { ...shapeElement({ rotation: 45 }), filetype: "group", name: "N" },
          card: imageElement({
            opacity: 100,
            link: {
              opacity: {
                from: { elementId: "spin", property: "rotation" },
                in: [-90, 0, 90],
                out: [0, 100, 0],
              },
            },
          } as never),
        } as unknown as Timeline,
      }),
      "outer",
      placed(),
    );
    expect((composed["outer::card"] as any).link.opacity.from.elementId).toBe(
      "outer::spin",
    );
    expect(resolveLinks(composed, "outer::card", 0)).toEqual({ opacity: 50 });
  });

  it("drops a link whose source is not in the template", () => {
    const composed = composeTemplate(
      data({
        elements: {
          card: imageElement({
            link: {
              opacity: {
                from: { elementId: "ghost", property: "rotation" },
                in: [0, 1],
                out: [0, 1],
              },
            },
          } as never),
        } as unknown as Timeline,
      }),
      "outer",
      placed(),
    );
    expect((composed["outer::card"] as any).link).toBeUndefined();
  });

  it("carries a transition's two clips into the namespace", () => {
    const composed = composeTemplate(
      data({
        elements: {
          a: imageElement(),
          b: imageElement(),
          cut: transitionElement({ fromId: "a", toId: "b" }),
        } as unknown as Timeline,
      }),
      "outer",
      placed(),
    );
    expect((composed["outer::cut"] as any).fromId).toBe("outer::a");
    expect((composed["outer::cut"] as any).toId).toBe("outer::b");
  });

  it("round-trips through innerKeyOf", () => {
    expect(innerKeyOf("outer::shot")).toEqual({
      outerId: "outer",
      innerKey: "shot",
    });
    expect(innerKeyOf("plain")).toBeNull();
  });
});

describe("filling a media slot", () => {
  it("swaps the source and moves the trim window to the in-point", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/mine.mp4",
            offsetMs: 5000,
            sourceDurationMs: 30000,
          },
        },
      }),
    );
    const shot = composed["outer::shot"] as any;
    expect(shot.localpath).toBe("file:///me/mine.mp4");
    expect(shot.trim).toEqual({ startTime: 5000, endTime: 8000 });
    expect(shot.sourceDuration).toBe(30000);
  });

  it("never changes the slot's duration", () => {
    // The invariant the whole feature rests on: a replacement cannot change
    // the template's timing. `duration === trim.endTime - trim.startTime`
    // holds, so `geometry.ts` stays satisfied too.
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/mine.mp4",
            offsetMs: 12000,
            sourceDurationMs: 60000,
          },
        },
      }),
    );
    const shot = composed["outer::shot"] as any;
    expect(shot.duration).toBe(3000);
    expect(shot.trim.endTime - shot.trim.startTime).toBe(3000);
  });

  it("clamps an in-point that would run off the end of the source", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/short.mp4",
            offsetMs: 9000,
            sourceDurationMs: 4000,
          },
        },
      }),
    );
    // 4000 long, 3000 needed: the latest legal in-point is 1000.
    expect((composed["outer::shot"] as any).trim).toEqual({
      startTime: 1000,
      endTime: 4000,
    });
  });

  it("starts at zero when the source is shorter than the slot", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/tiny.mp4",
            offsetMs: 400,
            sourceDurationMs: 1000,
          },
        },
      }),
    );
    // The window still spans the slot, so the invariant holds; the source
    // simply runs out inside it.
    expect((composed["outer::shot"] as any).trim).toEqual({
      startTime: 0,
      endTime: 3000,
    });
  });

  it("clamps a negative in-point", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/mine.mp4",
            offsetMs: -500,
            sourceDurationMs: 30000,
          },
        },
      }),
    );
    expect((composed["outer::shot"] as any).trim.startTime).toBe(0);
  });

  it("leaves the authored speed alone", () => {
    const composed = composeTemplate(
      data({
        elements: templateDoc({
          shot: videoElement({
            duration: 3000,
            speed: 2,
            sourceDuration: 3000,
            trim: { startTime: 0, endTime: 3000 },
            replaceable: { slotId: "hero" },
          }),
        }),
      }),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/mine.mp4",
            offsetMs: 0,
            sourceDurationMs: 30000,
          },
        },
      }),
    );
    // Speed and duration together are the slot's span on the timeline. Both
    // belong to the author.
    expect((composed["outer::shot"] as any).speed).toBe(2);
    expect((composed["outer::shot"] as any).duration).toBe(3000);
  });

  it("swaps an image's source without inventing a trim", () => {
    const composed = composeTemplate(
      data({
        elements: {
          pic: imageElement({ replaceable: { slotId: "hero" } }),
        } as Timeline,
      }),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/photo.png",
            offsetMs: 4000,
            sourceDurationMs: 0,
          },
        },
      }),
    );
    const pic = composed["outer::pic"] as any;
    expect(pic.localpath).toBe("file:///me/photo.png");
    expect(pic.trim).toBeUndefined();
  });

  it("fills every element sharing the slot", () => {
    const composed = composeTemplate(
      data({
        elements: {
          a: videoElement({
            duration: 1000,
            trim: { startTime: 0, endTime: 1000 },
            replaceable: { slotId: "hero" },
          }),
          b: videoElement({
            duration: 1000,
            trim: { startTime: 0, endTime: 1000 },
            replaceable: { slotId: "hero" },
          }),
        } as Timeline,
      }),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/mine.mp4",
            offsetMs: 0,
            sourceDurationMs: 9000,
          },
        },
      }),
    );
    expect((composed["outer::a"] as any).localpath).toBe("file:///me/mine.mp4");
    expect((composed["outer::b"] as any).localpath).toBe("file:///me/mine.mp4");
  });
});

describe("a fill of a different kind of picture", () => {
  const photo = {
    kind: "media" as const,
    localpath: "file:///me/photo.png",
    offsetMs: 0,
    sourceDurationMs: 0,
  };

  it("turns a video slot into a still, keeping the author's placement", () => {
    const source = data();
    const composed = composeTemplate(
      source,
      "outer",
      placed({ fills: { hero: photo } }),
    );
    const shot = composed["outer::shot"] as any;
    const authored = source.elements.shot as any;
    expect(shot.filetype).toBe("image");
    expect(shot.localpath).toBe("file:///me/photo.png");
    expect(shot.startTime).toBe(authored.startTime);
    expect(shot.duration).toBe(authored.duration);
    expect(shot.animation).toBe(authored.animation);
    for (const field of [
      "trim",
      "sourceDuration",
      "isExistAudio",
      "codec",
      "speed",
      "filter",
      "origin",
    ]) {
      expect(field in shot).toBe(false);
    }
  });

  it("takes a video slot to a gif", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({ fills: { hero: { ...photo, localpath: "file:///me/loop.gif" } } }),
    );
    expect((composed["outer::shot"] as any).filetype).toBe("gif");
    expect("trim" in (composed["outer::shot"] as any)).toBe(false);
  });

  it("turns an image slot into a video with a window over the fill", () => {
    const composed = composeTemplate(
      data({
        elements: {
          pic: imageElement({
            duration: 2000,
            width: 300,
            height: 200,
            replaceable: { slotId: "hero" },
          }),
        } as Timeline,
      }),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/clip.mov",
            offsetMs: 500,
            sourceDurationMs: 9000,
            hasAudio: true,
          },
        },
      }),
    );
    const pic = composed["outer::pic"] as any;
    expect(pic.filetype).toBe("video");
    expect(pic.trim).toEqual({ startTime: 500, endTime: 2500 });
    expect(pic.sourceDuration).toBe(9000);
    expect(pic.speed).toBe(1);
    expect(pic.isExistAudio).toBe(true);
    expect(pic.origin).toEqual({ width: 300, height: 200 });
    expect(pic.filter).toEqual({ enable: false, list: [] });
  });

  it("says no sound for a video fill that did not record any", () => {
    const composed = composeTemplate(
      data({
        elements: {
          pic: imageElement({ replaceable: { slotId: "hero" } }),
        } as Timeline,
      }),
      "outer",
      placed({
        fills: {
          hero: {
            kind: "media",
            localpath: "file:///me/clip.mp4",
            offsetMs: 0,
            sourceDurationMs: 4000,
          },
        },
      }),
    );
    expect((composed["outer::pic"] as any).isExistAudio).toBe(false);
  });

  it("takes a matching video fill's sound from the fill when it says", () => {
    const fill = (hasAudio?: boolean) =>
      composeTemplate(
        data(),
        "outer",
        placed({
          fills: {
            hero: {
              kind: "media",
              localpath: "file:///me/mine.mp4",
              offsetMs: 0,
              sourceDurationMs: 9000,
              ...(hasAudio == null ? {} : { hasAudio }),
            },
          },
        }),
      )["outer::shot"] as any;
    expect(fill(false).isExistAudio).toBe(false);
    expect(fill(true).isExistAudio).toBe(true);
    // A fill from before the field keeps the placeholder's answer.
    expect(fill().isExistAudio).toBe((templateDoc().shot as any).isExistAudio);
  });

  it("leaves the element's kind alone for a file it cannot place", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: { hero: { ...photo, localpath: "file:///me/notes.txt" } },
      }),
    );
    expect((composed["outer::shot"] as any).filetype).toBe("video");
  });
});

describe("filling a text slot", () => {
  it("replaces the text", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({ fills: { name: { kind: "text", text: "JUN" } } }),
    );
    expect((composed["outer::title"] as any).text).toBe("JUN");
  });

  it("accepts an empty string as a deliberate blanking", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({ fills: { name: { kind: "text", text: "" } } }),
    );
    expect((composed["outer::title"] as any).text).toBe("");
  });
});

describe("what a fill may not do", () => {
  it("ignores a fill whose kind does not match the slot", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: { kind: "text", text: "nope" },
          name: {
            kind: "media",
            localpath: "file:///me/mine.mp4",
            offsetMs: 0,
            sourceDurationMs: 1000,
          },
        },
      }),
    );
    expect((composed["outer::shot"] as any).localpath).toBe(
      "file:///lib/placeholder.mp4",
    );
    expect((composed["outer::title"] as any).text).toBe("YOUR NAME");
  });

  it("ignores a fill for a slot that does not exist", () => {
    expect(() =>
      composeTemplate(
        data(),
        "outer",
        placed({ fills: { ghost: { kind: "text", text: "x" } } }),
      ),
    ).not.toThrow();
  });

  it("ignores a malformed fill without throwing", () => {
    const composed = composeTemplate(
      data(),
      "outer",
      placed({
        fills: {
          hero: { kind: "media", localpath: "", offsetMs: 0, sourceDurationMs: 1 },
          name: { kind: "text" } as any,
        },
      }),
    );
    expect((composed["outer::shot"] as any).localpath).toBe(
      "file:///lib/placeholder.mp4",
    );
    expect((composed["outer::title"] as any).text).toBe("YOUR NAME");
  });

  it("leaves an unfilled slot holding its placeholder", () => {
    const composed = composeTemplate(data(), "outer", placed());
    expect((composed["outer::shot"] as any).localpath).toBe(
      "file:///lib/placeholder.mp4",
    );
    expect((composed["outer::title"] as any).text).toBe("YOUR NAME");
  });

  it("does not mutate the template's own document", () => {
    // The registry hands out one `TemplateData` to every instance, so a write
    // through it would leak one user's footage into another's copy.
    const shared = data();
    const before = JSON.stringify(shared.elements);
    composeTemplate(
      shared,
      "outer",
      placed({ fills: { name: { kind: "text", text: "MUTATED" } } }),
    );
    expect(JSON.stringify(shared.elements)).toBe(before);
  });
});

describe("nesting", () => {
  it("strips a template found inside a template", () => {
    // Capped at one level. The alternative is a depth counter threaded through
    // a render path that has no other reason to know about recursion.
    const composed = composeTemplate(
      data({
        elements: {
          keep: imageElement(),
          nested: placed({ key: "nested" }),
        } as unknown as Timeline,
      }),
      "outer",
      placed(),
    );
    expect(Object.keys(composed)).toEqual(["outer::keep"]);
  });
});

describe("expandTemplates", () => {
  const resolve = (id: string) => (id === "neon" ? data() : null);

  it("returns the document by identity when it holds no template", () => {
    // Identity matters: `loadedAssetStore` and the renderer's priority cache
    // both key on it, so a fresh object every frame would defeat them.
    const elements = { a: imageElement() } as Timeline;
    expect(expandTemplates(elements, resolve)).toBe(elements);
  });

  it("adds the inner elements rebased onto the outer timeline", () => {
    const expanded = expandTemplates(
      { tpl: placed({ startTime: 10_000 }) } as unknown as Timeline,
      resolve,
    );
    // `shot` sits at 0 inside the template, so at 10s on the real timeline.
    expect(expanded["tpl::shot"].startTime).toBe(10_000);
    // `title` sits at 3s inside it.
    expect(expanded["tpl::title"].startTime).toBe(13_000);
  });

  it("keeps the template element itself", () => {
    const expanded = expandTemplates(
      { tpl: placed() } as unknown as Timeline,
      resolve,
    );
    expect(expanded.tpl.filetype).toBe("template");
  });

  it("expands two templates independently", () => {
    const expanded = expandTemplates(
      {
        a: placed({ startTime: 0 }),
        b: placed({ startTime: 20_000 }),
      } as unknown as Timeline,
      resolve,
    );
    expect(expanded["a::shot"].startTime).toBe(0);
    expect(expanded["b::shot"].startTime).toBe(20_000);
  });

  it("passes a template that is not installed through untouched", () => {
    const elements = {
      tpl: placed({ templateId: "missing" }),
    } as unknown as Timeline;
    const expanded = expandTemplates(elements, resolve);
    expect(Object.keys(expanded)).toEqual(["tpl"]);
  });

  it("carries the user's fills into the expansion", () => {
    // The asset layer has to decode what will actually be drawn, not the
    // placeholder the template shipped.
    const expanded = expandTemplates(
      {
        tpl: placed({
          fills: {
            hero: {
              kind: "media",
              localpath: "file:///me/mine.mp4",
              offsetMs: 0,
              sourceDurationMs: 9000,
            },
          },
        }),
      } as unknown as Timeline,
      resolve,
    );
    expect((expanded["tpl::shot"] as any).localpath).toBe(
      "file:///me/mine.mp4",
    );
  });
});

describe("bakeFills", () => {
  it("applies the instance's fills under the template's own keys", () => {
    const baked = bakeFills(
      data(),
      placed({ fills: { name: { kind: "text", text: "Ada" } } }),
    );
    expect(Object.keys(baked).sort()).toEqual(["bg", "shot", "title"]);
    expect((baked.title as any).text).toBe("Ada");
    expect((baked.title as any).key).toBe(templateDoc().title.key);
  });

  it("hands an unfilled element through by reference", () => {
    const source = data();
    const baked = bakeFills(source, placed());
    expect(baked.bg).toBe(source.elements.bg);
    expect(baked.shot).toBe(source.elements.shot);
  });

  it("leaves a nested template out", () => {
    const baked = bakeFills(
      data({
        elements: {
          ...templateDoc(),
          inner: placed({ templateId: "other" }),
        } as unknown as Timeline,
      }),
      placed(),
    );
    expect(baked.inner).toBeUndefined();
  });

  it("is what composeTemplate namespaces, element for element", () => {
    const element = placed({
      fills: {
        hero: {
          kind: "media",
          localpath: "file:///me/mine.mp4",
          offsetMs: 500,
          sourceDurationMs: 9000,
        },
      },
    });
    const baked = bakeFills(data(), element);
    const composed = composeTemplate(data(), "o", element);
    for (const key of Object.keys(baked)) {
      expect({ ...(composed[`o::${key}`] as any), key: undefined }).toEqual({
        ...(baked[key] as any),
        key: undefined,
      });
    }
  });
});

describe("expandTemplates cuts the contents at the bar", () => {
  const resolve = () => data();

  it("trims a clip that runs past the end of a shorter bar", () => {
    // The template runs 6s; its bar on the timeline only 4s.
    const expanded = expandTemplates(
      { tpl: placed({ startTime: 1000, duration: 4000 }) } as unknown as Timeline,
      resolve,
    );
    const title = expanded["tpl::title"] as any;
    // 3000..6000 inside, so 4000..7000 placed; the bar ends at 5000.
    expect(title.startTime).toBe(4000);
    expect(title.duration).toBe(1000);
  });

  it("leaves out a clip that starts after the bar ends", () => {
    const expanded = expandTemplates(
      { tpl: placed({ startTime: 0, duration: 2500 }) } as unknown as Timeline,
      resolve,
    );
    expect(expanded["tpl::title"]).toBeUndefined();
    // The video slot, 0..3000, is cut to the bar's 2500 through its trim.
    const shot = expanded["tpl::shot"] as any;
    expect(shot.duration).toBe(2500);
    expect(shot.trim.endTime - shot.trim.startTime).toBe(2500);
  });

  it("leaves a clip that fits alone", () => {
    const expanded = expandTemplates(
      { tpl: placed({ startTime: 0, duration: 6000 }) } as unknown as Timeline,
      resolve,
    );
    expect((expanded["tpl::title"] as any).duration).toBe(3000);
    expect((expanded["tpl::shot"] as any).duration).toBe(3000);
  });
});

