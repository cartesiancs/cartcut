/**
 * Which side of the export loses a frame?
 *
 * The index map over a real export showed output frame N carrying source frame
 * N-1 for every ordinal where `N mod 3 === 2`, at 30fps, from a 30fps source.
 * That has two possible homes: the renderer drew the wrong frame, or the
 * encoder placed the right frame at the wrong index. This spec answers it by
 * cutting the encoder out entirely — it seeks and composites in the page, on
 * the export's own code path, and reads the burned-in index straight off the
 * canvas.
 *
 * Diagnostic rather than an assertion. It is here so the answer is reproducible
 * and so a regression in `loadedAssetStore.seek` has somewhere to show up.
 */

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { setFpsThroughStore, setResolution } from "../harness/ui";

test("the renderer's own frames carry the index the frame loop asked for", async ({
  session,
  instruments,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const { page } = session;
  const fps = 30;
  const probeCount = 40;

  await setResolution(page, 640, 360);
  await setFpsThroughStore(page, fps);

  await agent(session, "add_media", {
    items: [{ path: instruments.paths.code, startMs: 0, durationMs: 20_000 }],
    sequential: false,
  });

  const { code } = instruments.regions;

  const probe = await page.evaluate(
    async ({ fps: rate, count, code: band }) => {
      const C = (globalThis as any).CARTCUT;
      const timeline = C.useTimelineStore.getState().timeline;
      const options = C.renderOptionStore.getState().options;
      const { w, h } = options.previewSize;

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;

      const handles = C.loadedAssetStore.getState();

      // The export does this before its frame loop. Without it there are no
      // `<video>` handles at all, `seek` is a no-op over an empty list, and
      // every frame composites black — which looks exactly like a total
      // rendering failure.
      await handles.loadEntireTimeline(timeline, { audio: false });

      const videoId = Object.keys(timeline).find((id) => timeline[id].filetype === "video")!;
      const videoEl = timeline[videoId];

      const out: Array<{
        n: number; wantMs: number; currentTime: number | null; decoded: number; raw: number[];
      }> = [];

      for (let n = 0; n < count; n++) {
        const timeMs = C.frameTimeMs(n, rate);
        await handles.seek(timeline, timeMs);

        // Exactly what `renderTimeline` does per frame.
        C.renderTimelineAtTime(
          ctx, timeline, timeMs, C.exportElementRenderers,
          options.backgroundColor, w, h, undefined, undefined, null,
        );

        // The band is authored in project pixels and the element is placed at
        // 1:1, so patch k's centre is at x = k*patch + patch/2.
        const raw: number[] = [];
        let decoded = 0;
        for (let k = 0; k < band.bits; k++) {
          const x = band.x + k * band.patch + Math.floor(band.patch / 2);
          const y = band.y + Math.floor(band.h / 2);
          const px = ctx.getImageData(x, y, 1, 1).data;
          raw.push(px[0]);
          if (px[0] > 128) decoded |= 1 << k;
        }

        const media: any = Object.values(
          C.loadedAssetStore.getState()._loadedElementVideo ?? {},
        ).find((m: any) => m.elementId === videoId);

        out.push({
          n,
          wantMs: timeMs,
          currentTime: media?.object?.currentTime ?? null,
          decoded,
          raw,
        });
      }

      return {
        samples: out,
        // Where the strip actually sits, so a decode of the wrong pixels is
        // distinguishable from a decode of the wrong frame.
        placement: {
          x: videoEl.location?.x, y: videoEl.location?.y,
          w: videoEl.width, h: videoEl.height,
          startTime: videoEl.startTime, duration: videoEl.duration,
          trim: videoEl.trim, speed: videoEl.speed,
          origin: videoEl.origin,
        },
        band,
      };
    },
    { fps, count: probeCount, code },
  );

  const samples = probe.samples;
  const mismatches = samples.filter((s) => s.decoded !== s.n);

  await testInfo.attach("seek-samples.json", {
    body: JSON.stringify(
      {
        fps,
        mismatchCount: mismatches.length,
        offsetsSeen: [...new Set(mismatches.map((m) => m.decoded - m.n))],
        mismatchOrdinalsMod3: [...new Set(mismatches.map((m) => m.n % 3))],
        placement: probe.placement,
        band: probe.band,
        samples,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // Reported, not asserted — this spec exists to characterise the behaviour.
  // The assertion that matters lives in the stress spec's index map.
  test.info().annotations.push({
    type: "seek-fidelity",
    description:
      `${mismatches.length}/${probeCount} composited frames carried the wrong source index ` +
      `(offsets ${[...new Set(mismatches.map((m) => m.decoded - m.n))].join(",") || "none"})`,
  });

  expect(samples.length).toBe(probeCount);
});
