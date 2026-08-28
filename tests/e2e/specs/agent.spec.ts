/**
 * The command channel the scenario builder relies on.
 *
 * Worth its own spec because everything downstream assumes it: if `add_media`
 * silently places nothing, the render spec exports a black video and the frame
 * comparison reports a wall of mismatches that say nothing about the cause.
 */

import { test, expect } from "../harness/test";
import { agent, listClips, projectOverview, timelineDocument } from "../harness/agent";

test("editor commands run over the shipping agent IPC", async ({ session }) => {
  await expect(agent(session, "ping")).resolves.toBeDefined();

  const overview = await projectOverview(session);
  expect(overview).toMatchObject({ fps: expect.any(Number) });

  // An unknown command must reject, not hang. A hang here would cost the run
  // its entire timeout with nothing in the report to explain it.
  await expect(agent(session, "definitely_not_a_command")).rejects.toThrow(/failed/);
});

test("media imported through the agent lands on the timeline and in the UI", async ({
  session,
  fixtures,
  instruments,
  profile,
}) => {
  const clip = fixtures.video.find((v) => v.id === "v01-h264-1080p60")!;
  const audio = fixtures.audio.find((a) => a.id === "a04-tone440-gaps")!;

  const added = await agent<any>(session, "add_media", {
    items: [
      { path: clip.path, startMs: 0, durationMs: 4000 },
      { path: instruments.paths.code, startMs: 0, durationMs: 4000 },
      { path: audio.path, startMs: 0, durationMs: 4000 },
    ],
    sequential: false,
  });

  // `add_media` reports unreadable files in `skipped` rather than throwing, so
  // a silently-empty import would otherwise look like success.
  expect(added.skipped ?? []).toEqual([]);

  const { clips } = await listClips(session);
  expect(clips.length).toBeGreaterThanOrEqual(3);
  expect(new Set(clips.map((c) => c.type))).toEqual(new Set(["video", "audio"]));
  for (const row of clips) {
    expect(row.dur).toBeGreaterThan(0);
    expect(row.end).toBe(row.start + row.dur);
  }

  // The document is the authority for the two filetypes `serialize.ts` hides.
  const doc = await timelineDocument(session);
  expect(Object.keys(doc).length).toBeGreaterThanOrEqual(3);

  // And the UI actually repainted — the store changing is not the same claim.
  const painted = await session.page.evaluate(() => {
    const canvas = document.querySelector("#elementTimelineCanvasRef") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) lit++;
    }
    return { lit, total: data.length / 4 };
  });
  expect(painted.lit).toBeGreaterThan(0);

  void profile;
});
