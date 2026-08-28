/**
 * One project containing everything the editor can hold.
 *
 * All nine filetypes from `@types/timeline.ts` — video, image, gif, shape,
 * text, audio, group, effect, transition — plus trims, speeds, filters,
 * keyframes, multiple tracks of each kind, and z-order changed after the fact.
 * The point is not tidiness; it is to put the compositor and the FFmpeg graph
 * under as much simultaneous load as the app can legally be asked to carry.
 *
 * Times are fractions of the profile's duration rather than literals, so the
 * same scenario is a twenty-second smoke run and a five-minute stress run
 * without a second copy that can drift.
 *
 * **What is placed by clicking and what is placed by command.** Transitions and
 * effects go through the fx tile grid, because there is no agent command for
 * either — `define.ts`'s `FILETYPES` omits both filetypes entirely. Everything
 * else is placed over the agent IPC: twenty clips and three hundred keyframes
 * driven by synthetic mouse events would add flake without adding coverage, and
 * that path runs the same pure ops through the same single undo step as the
 * mouse does.
 *
 * The instrument bands are placed first and on the topmost tracks, because
 * every measurement in `frameParity` depends on nothing ever covering them.
 */

import type { AppSession } from "../harness/launch";
import { agent, timelineDocument, type ClipRow } from "../harness/agent";
import { applyFxPreset, clearSelection } from "../harness/ui";
import type { FixtureManifest, InstrumentSet, Profile } from "../harness/paths";
import { ANIM_CARRIER_PERIOD, ANIM_CARRIER_STEP_PX } from "./carriers";

export type BuildContext = {
  session: AppSession;
  profile: Profile;
  fixtures: FixtureManifest;
  instruments: InstrumentSet;
};

export type PlacedClip = { id: string; role: string; startMs: number; endMs: number };

export type ScenarioResult = {
  placed: PlacedClip[];
  /** Element ids by role, for the sampler and for targeted assertions. */
  byRole: Record<string, string[]>;
  tracks: Record<string, string>;
  transitions: string[];
  effects: string[];
  /** Human-readable log of what was applied, for the artifact. */
  steps: string[];
};

const ms = (profile: Profile, fraction: number) =>
  Math.round(profile.durationSec * 1000 * fraction);

/** Snap to the frame grid, the way every edit in the app does. */
const onFrame = (profile: Profile, timeMs: number) =>
  Math.round((timeMs / 1000) * profile.fps) * (1000 / profile.fps);

async function addTrack(session: AppSession, kind: "video" | "audio" | "text"): Promise<string> {
  const result = await agent<any>(session, "add_track", { kind });
  const id = result?.tracks?.added?.[0] ?? result?.trackId ?? result?.id;
  if (id == null) {
    throw new Error(`add_track(${kind}) did not report a new track id: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return id;
}

/**
 * Place one clip at an exact span on an exact track.
 *
 * `add_media` cannot do this by itself, and the reason is a genuine gap rather
 * than a quirk worth working around quietly: its MCP schema declares
 * `items[].startMs`, `items[].durationMs` and `items[].trackId`, but
 * `features/agent/commands/media.ts` reads none of them — it uses only the
 * batch-level `params.startMs` and hands everything to `placeImported`. So a
 * caller asking for a three-second clip on a named track gets a clip of the
 * source's full length on whichever track placement chose. See FINDINGS.md.
 *
 * The span is therefore set afterwards, with the two commands that do honour
 * their arguments: `trim_clip` for the out-point and `move_clips` for the
 * track. Trim before moving — trimming a full-length clip after it has landed
 * on a track that already has neighbours is what `trim_clip`'s "clamped by
 * neighbours" clause would refuse.
 */
async function addMediaAt(
  session: AppSession,
  path: string,
  startMs: number,
  durationMs: number,
  trackId?: string,
): Promise<string> {
  const result = await agent<any>(session, "add_media", {
    items: [{ path }],
    startMs,
    sequential: false,
  });
  if ((result?.skipped ?? []).length > 0) {
    throw new Error(`add_media refused ${path}: ${JSON.stringify(result.skipped)}`);
  }
  const id = result?.created?.[0];
  if (id == null) throw new Error(`add_media created nothing for ${path}`);

  const span = await agent<any>(session, "get_clip", { elementId: id }).catch(() => null);
  const currentEnd = span?.end ?? span?.clip?.end;
  const wantEnd = startMs + durationMs;

  if (currentEnd == null || Math.abs(currentEnd - wantEnd) > 1) {
    await agent(session, "trim_clip", { elementId: id, endMs: wantEnd })
      .catch(() => { /* shorter than asked for is fine; the assertions read the real span */ });
  }

  if (trackId != null) {
    await agent(session, "move_clips", { elementIds: [id], toMs: startMs, trackId })
      .catch((error) => {
        throw new Error(
          `could not move ${path.split("/").pop()} to track ${trackId}: ${(error as Error).message}`,
        );
      });
  }

  return id;
}

/** What the app actually did with a clip, as opposed to what it was asked. */
async function actualSpan(session: AppSession, id: string): Promise<{ startMs: number; endMs: number }> {
  const clip = await agent<any>(session, "get_clip", { elementId: id });
  const start = clip?.start ?? clip?.clip?.start ?? 0;
  const dur = clip?.dur ?? clip?.clip?.dur ?? 0;
  return { startMs: start, endMs: start + dur };
}

/** Place an element at exact project pixels — the instruments depend on this. */
async function placeExactly(
  session: AppSession,
  elementId: string,
  box: { x: number; y: number; w: number; h: number },
): Promise<void> {
  await agent(session, "update_clip", {
    elementId,
    patch: { location: { x: box.x, y: box.y }, width: box.w, height: box.h },
  });
}

export async function buildKitchenSink(ctx: BuildContext): Promise<ScenarioResult> {
  const { session, profile, fixtures, instruments } = ctx;
  const D = profile.durationSec * 1000;
  const at = (f: number) => onFrame(profile, ms(profile, f));

  const placed: PlacedClip[] = [];
  const byRole: Record<string, string[]> = {};
  const steps: string[] = [];
  const tracks: Record<string, string> = {};

  const record = (role: string, id: string, startMs: number, endMs: number) => {
    placed.push({ id, role, startMs, endMs });
    (byRole[role] ??= []).push(id);
  };
  const note = (text: string) => steps.push(text);

  const video = (id: string) => fixtures.video.find((v) => v.id === id)!.path;
  const audio = (id: string) => fixtures.audio.find((a) => a.id === id)!.path;
  const still = (id: string) => (fixtures as any).still.find((s: any) => s.id === id)!.path;

  // ---------------------------------------------------------- 1. instruments
  //
  // First, and on their own tracks, so nothing else can ever be composited over
  // a band a measurement reads.

  const { code, swatch, ticker } = instruments.regions;

  // One track each, and this is not tidiness.
  //
  // All four instruments span the whole timeline, so putting them on a single
  // track makes them fight for the same span: the first wins it and the rest
  // are bumped onto whatever track placement finds, underneath the content.
  // That failure is silent and it is *nearly* silent in the results too — the
  // code strip still read perfectly from the top track while the ticker sat
  // beneath a video clip, so the alignment search compared a band that never
  // changed and quietly found no winner anywhere.
  const instrumentSpecs = [
    { role: "code", path: instruments.paths.code, box: code },
    { role: "swatch", path: instruments.paths.swatch, box: swatch },
    { role: "ticker", path: instruments.paths.ticker, box: ticker },
    {
      role: "syncFlash",
      path: instruments.paths.syncFlash,
      box: {
        x: Math.round(profile.width * 0.75),
        y: Math.round(profile.height * 0.5),
        w: Math.round(profile.width / 6),
        h: Math.round(profile.height / 6),
      },
    },
  ];

  const instrumentTracks: string[] = [];
  for (const spec of instrumentSpecs) {
    const trackId = await addTrack(session, "video");
    instrumentTracks.push(trackId);
    tracks[`instrument:${spec.role}`] = trackId;

    const id = await addMediaAt(session, spec.path, 0, D, trackId);
    await placeExactly(session, id, {
      x: spec.box.x, y: spec.box.y, w: spec.box.w, h: spec.box.h,
    });
    record(`instrument:${spec.role}`, id, 0, D);
  }
  const instrumentTrack = instrumentTracks[0];
  note(
    `${instrumentSpecs.length} instruments, one track each: ` +
    `code ${code.w}x${code.h}, swatch, ticker ${ticker.w}x${ticker.h}, sync flash`,
  );

  // ------------------------------------------ 2. the animation-only carrier
  //
  // A shape whose x sawtooths one step per frame. It reports which frame the
  // *animation* system thinks it is on with no video decoder involved, so
  // comparing it against the code strip separates "the video seek is off by
  // one" from "the frame clock is off by one".

  const carrierTrack = await addTrack(session, "video");
  tracks.carrier = carrierTrack;
  const carrierY = Math.round(profile.height * 0.62);
  const carrierSize = Math.max(8, Math.round(profile.width / 80));

  // An image, not a shape. `animatableProperties` returns `["opacity"]` alone
  // for `shape` and `effect`, so the app refuses a position keyframe on a shape
  // outright — "A shape clip cannot animate position". An image takes all four.
  const carrierId = await addMediaAt(
    session, instruments.paths.carrierBlock, 0, D, carrierTrack,
  );
  if (carrierId != null) {
    await placeExactly(session, carrierId, {
      x: 0, y: carrierY, w: carrierSize, h: carrierSize,
    });
    // One authored keyframe per sawtooth vertex. `bakeTrack` samples at 60Hz,
    // so at 60fps each export frame gets its own baked sample.
    const cycleMs = (ANIM_CARRIER_PERIOD / profile.fps) * 1000;
    const cycles = Math.min(150, Math.floor(D / cycleMs));
    const keyframes: Array<{ atMs: number; x: number; y: number }> = [];
    for (let c = 0; c <= cycles; c++) {
      keyframes.push({ atMs: Math.round(c * cycleMs), x: 0, y: carrierY });
      const endMs = Math.round((c + 1) * cycleMs) - 1;
      if (endMs < D) {
        keyframes.push({ atMs: endMs, x: ANIM_CARRIER_PERIOD * ANIM_CARRIER_STEP_PX, y: carrierY });
      }
    }
    await agent(session, "add_keyframes", {
      elementId: carrierId,
      property: "position",
      keyframes: keyframes.filter((k) => k.atMs < D),
    });
    record("carrier:animation", carrierId, 0, D);
    note(`animation carrier: ${keyframes.length} position keyframes over ${cycles} cycles`);
  }

  // ------------------------------------------------------- 3. the main cuts
  //
  // Twelve real clips laid end to end across the whole timeline, every codec,
  // resolution and frame rate the fixture set has. The cuts between them are
  // where the transitions go.

  const mainTrack = await addTrack(session, "video");
  tracks.main = mainTrack;

  const clipIds = fixtures.video.map((v) => v.id);
  const slot = D / clipIds.length;
  const mainIds: string[] = [];

  for (let i = 0; i < clipIds.length; i++) {
    const startMs = onFrame(profile, i * slot);
    const endMs = onFrame(profile, (i + 1) * slot);
    const id = await addMediaAt(session, video(clipIds[i]), startMs, endMs - startMs, mainTrack);
    mainIds.push(id);
    record(`main:${clipIds[i]}`, id, startMs, endMs);
  }
  note(`${mainIds.length} video clips laid end to end on ${mainTrack}`);

  // The three video filters, one each.
  const filters = [
    { name: "chromakey" as const, color: "#00b140", threshold: 0.4 },
    { name: "blur" as const, strength: 6 },
    { name: "radialblur" as const, strength: 8 },
  ];
  for (let i = 0; i < filters.length; i++) {
    const target = mainIds[i * 3 + 2];
    if (target == null) continue;
    await agent(session, "set_video_filters", { elementIds: [target], filter: filters[i] });
    record(`filter:${filters[i].name}`, target, 0, 0);
    note(`${filters[i].name} on clip ${i * 3 + 2}`);
  }

  // Opacity and rotation, which take the transform path rather than the filter one.
  if (mainIds[4] != null) {
    await agent(session, "update_clip", { elementId: mainIds[4], patch: { opacity: 55, rotation: 12 } });
    note("opacity 55 / rotation 12 on clip 4");
  }

  // ------------------------------------------------------------- 4. overlays

  const overlayTrack = await addTrack(session, "video");
  tracks.overlay = overlayTrack;

  const imageId = await addMediaAt(session, still("i01-still-1080p"), at(0.05), Math.round(D * 0.1), overlayTrack);
  await placeExactly(session, imageId, {
    x: Math.round(profile.width * 0.05), y: Math.round(profile.height * 0.3),
    w: Math.round(profile.width * 0.25), h: Math.round(profile.height * 0.25),
  });
  await agent(session, "update_clip", { elementId: imageId, patch: { opacity: 80 } });
  record("overlay:image", imageId, at(0.05), at(0.15));

  const alphaId = await addMediaAt(session, still("i02-alpha"), at(0.2), Math.round(D * 0.1), overlayTrack);
  await placeExactly(session, alphaId, {
    x: Math.round(profile.width * 0.35), y: Math.round(profile.height * 0.3),
    w: Math.round(profile.width * 0.2), h: Math.round(profile.height * 0.2),
  });
  record("overlay:alphaImage", alphaId, at(0.2), at(0.3));

  const gifId = await addMediaAt(session, still("g01-animated"), at(0.35), Math.round(D * 0.1), overlayTrack);
  await placeExactly(session, gifId, {
    x: Math.round(profile.width * 0.6), y: Math.round(profile.height * 0.3),
    w: Math.round(profile.width * 0.22), h: Math.round(profile.height * 0.22),
  });
  record("overlay:gif", gifId, at(0.35), at(0.45));
  note("image, alpha image and animated gif placed on the overlay track");

  // Shapes: the three built-in kinds plus a free-form polygon.
  const shapeSpecs = [
    { kind: "rectangle" as const, fillColor: "#ff5964", x: 0.05 },
    { kind: "ellipse" as const, fillColor: "#38b000", x: 0.2 },
    { kind: "triangle" as const, fillColor: "#4361ee", x: 0.35 },
  ];
  for (const [i, spec] of shapeSpecs.entries()) {
    const created = await agent<any>(session, "add_shape", {
      kind: spec.kind,
      startMs: at(0.5),
      durationMs: Math.round(D * 0.12),
      x: Math.round(profile.width * spec.x),
      y: Math.round(profile.height * 0.68),
      width: Math.round(profile.width * 0.1),
      height: Math.round(profile.height * 0.1),
      fillColor: spec.fillColor,
    });
    const id = created?.created?.[0];
    if (id != null) record(`shape:${spec.kind}`, id, at(0.5), at(0.62));
    void i;
  }

  const polygon = await agent<any>(session, "add_shape", {
    points: [[0, 0], [100, 20], [80, 100], [20, 80], [10, 40]],
    startMs: at(0.5),
    durationMs: Math.round(D * 0.12),
    x: Math.round(profile.width * 0.5),
    y: Math.round(profile.height * 0.68),
    width: Math.round(profile.width * 0.1),
    height: Math.round(profile.height * 0.1),
    fillColor: "#ffbe0b",
  });
  if (polygon?.created?.[0] != null) {
    record("shape:polygon", polygon.created[0], at(0.5), at(0.62));
  }
  note("four shapes: rectangle, ellipse, triangle and a free-form polygon");

  // ------------------------------------------------------------ 5. text
  //
  // One heavily-styled title exercising every writable text property, plus a
  // run of subtitles placed in a single undo step.

  const textTrack = await addTrack(session, "text");
  tracks.text = textTrack;

  const title = await agent<any>(session, "add_text", {
    text: "Cartcut stress export",
    startMs: at(0.02),
    durationMs: Math.round(D * 0.12),
    style: {
      fontsize: Math.round(profile.height / 12),
      textcolor: "#ffffff",
      align: "center",
      background: true,
      locationX: Math.round(profile.width * 0.2),
      locationY: Math.round(profile.height * 0.42),
      width: Math.round(profile.width * 0.6),
      height: Math.round(profile.height / 8),
    },
  });
  const titleId = title?.created?.[0];
  if (titleId != null) {
    record("text:title", titleId, at(0.02), at(0.14));
    // Every text embellishment the whitelist allows, in one patch.
    await agent(session, "update_clip", {
      elementId: titleId,
      patch: {
        letterSpacing: 2,
        textOpacity: 95,
        options: {
          isBold: true,
          isItalic: false,
          align: "center",
          textTransform: "uppercase",
          outline: { enable: true, size: 3, color: "#000000", opacity: 90 },
          shadow: { enable: true, offsetX: 4, offsetY: 4, blur: 12, color: "#000000", opacity: 70 },
          glow: { enable: true, size: 10, color: "#00e5ff", opacity: 60 },
        },
        background: { enable: true, color: "#101820", opacity: 55, padding: 18, radius: 12 },
        fill: { type: "gradient", from: "#ffd166", to: "#ef476f", angle: 35 },
      },
    });
    note("title text with outline, shadow, glow, background and a gradient fill");

    // A bundled font, so the render does not depend on what the host has.
    const fonts = await agent<any>(session, "list_fonts", { limit: 200 }).catch(() => null);
    const bundled = fonts?.fonts?.find?.((f: any) => /Anton|Bebas|Inter/i.test(f.name ?? ""));
    if (bundled?.path != null) {
      await agent(session, "set_text_font", { elementIds: [titleId], fontPath: bundled.path });
      note(`title font set to ${bundled.name}`);
    }
  }

  const subtitleCount = Math.max(6, Math.round(profile.durationSec / 4));
  const subtitleItems = Array.from({ length: subtitleCount }, (_, i) => {
    const startMs = onFrame(profile, D * 0.2 + (i * D * 0.7) / subtitleCount);
    return {
      text: `Caption line ${i + 1} — the quick brown fox jumps over the lazy dog`,
      startMs,
      durationMs: Math.round((D * 0.7) / subtitleCount) - 100,
    };
  });
  const subs = await agent<any>(session, "add_subtitles", {
    items: subtitleItems,
    style: { fontsize: Math.round(profile.height / 24), textcolor: "#ffffff", align: "center", background: true },
  });
  for (const id of subs?.created ?? []) record("text:subtitle", id, 0, 0);
  note(`${subtitleItems.length} subtitle lines in one undo step`);

  // -------------------------------------------------------------- 6. group
  //
  // A spatial parent over two of the shapes, then animated — so the group's
  // own transform has to compose with its children's.

  const groupChildren = (byRole["shape:rectangle"] ?? []).concat(byRole["shape:ellipse"] ?? []);
  if (groupChildren.length >= 2) {
    const grouped = await agent<any>(session, "group_clips", {
      elementIds: groupChildren,
      name: "Shape group",
    });
    const groupId = grouped?.created?.[0];
    if (groupId != null) {
      record("group", groupId, at(0.5), at(0.62));
      await agent(session, "add_keyframes", {
        elementId: groupId,
        property: "rotation",
        keyframes: [
          { atMs: at(0.5), value: 0 },
          { atMs: at(0.56), value: 25 },
          { atMs: at(0.61), value: -10 },
        ],
      }).catch(() => note("group rotation keyframes refused (group span too short)"));
      note("two shapes grouped and the group rotated by keyframe");
    }
  }

  // ----------------------------------------------------------- 7. keyframes
  //
  // All four animatable properties, plus the presets, spread across clips.

  if (mainIds[0] != null) {
    await agent(session, "apply_animation_preset", {
      elementIds: [mainIds[0]],
      preset: "fade_in",
      durationMs: Math.min(800, Math.round(slot / 3)),
    });
    record("anim:fade_in", mainIds[0], 0, 0);
  }
  if (mainIds[mainIds.length - 1] != null) {
    await agent(session, "apply_animation_preset", {
      elementIds: [mainIds[mainIds.length - 1]],
      preset: "fade_out",
      durationMs: Math.min(800, Math.round(slot / 3)),
    });
  }
  if (imageId != null) {
    await agent(session, "add_keyframes", {
      elementId: imageId,
      property: "scale",
      // Tenths: 10 is unscaled.
      keyframes: [
        { atMs: at(0.05), value: 10 },
        { atMs: at(0.1), value: 14 },
        { atMs: at(0.149), value: 9 },
      ],
    }).catch(() => note("image scale keyframes refused"));
    await agent(session, "add_keyframes", {
      elementId: imageId,
      property: "opacity",
      keyframes: [
        { atMs: at(0.05), value: 0 },
        { atMs: at(0.08), value: 100 },
        { atMs: at(0.149), value: 20 },
      ],
    }).catch(() => note("image opacity keyframes refused"));
    record("anim:keyframed", imageId, at(0.05), at(0.15));
    note("image animated on scale and opacity");
  }

  // ------------------------------------------------------------- 8. audio
  //
  // Five tracks that all overlap, so FFmpeg's `amix` has real work: five
  // inputs, three sample rates, two channel layouts, and one clip retimed with
  // `atempo`.

  const audioSpecs = [
    { id: "a01-sintel-stereo48k", startFraction: 0.0, volumeDb: 0, speed: 1 },
    { id: "a02-example-pcm441", startFraction: 0.15, volumeDb: -6, speed: 1 },
    { id: "a03-bbb-mp3-mono44k", startFraction: 0.3, volumeDb: -12, speed: 1.5 },
    { id: "a04-tone440-gaps", startFraction: 0.45, volumeDb: -18, speed: 1 },
  ];

  for (const [i, spec] of audioSpecs.entries()) {
    const trackId = await addTrack(session, "audio");
    tracks[`audio${i + 1}`] = trackId;
    const startMs = at(spec.startFraction);
    const source = fixtures.audio.find((a) => a.id === spec.id);
    if (source == null) continue;
    const durationMs = Math.min(Math.round(source.durationSec * 1000), D - startMs);
    if (durationMs <= 0) continue;

    const id = await addMediaAt(session, audio(spec.id), startMs, durationMs, trackId);
    record(`audio:${spec.id}`, id, startMs, startMs + durationMs);

    if (spec.volumeDb !== 0) {
      await agent(session, "update_clip", { elementId: id, patch: { volumeDb: spec.volumeDb } });
    }
    if (spec.speed !== 1) {
      await agent(session, "set_clip_speed", { elementIds: [id], speed: spec.speed, ripple: false });
    }
  }

  // The fifth: the sync clicks, whose position the A/V check depends on. Placed
  // at zero so a click lands on the same frame as the flash it was generated
  // with.
  const clickTrack = await addTrack(session, "audio");
  tracks.audio5 = clickTrack;
  const clickId = await addMediaAt(session, instruments.paths.syncClick, 0, D, clickTrack);
  record("audio:syncClick", clickId, 0, D);
  note(`5 audio tracks placed, overlapping — amix gets ${audioSpecs.length + 1} inputs`);

  // --------------------------------------------- 9. transitions and effects
  //
  // The UI, because there is no command for either.

  const transitions: string[] = [];
  const effects: string[] = [];

  const before = await timelineDocument(session);
  // Names as each preset's own manifest.json spells them.
  const transitionPresets = ["Cross Dissolve", "Linear Wipe", "Push", "Slide", "Iris Circle", "Zoom In", "Whip Pan", "Flash"];

  for (let i = 0; i < Math.min(transitionPresets.length, mainIds.length - 1); i++) {
    const cut = await actualSpan(session, mainIds[i]);
    try {
      // `applyTransition` puts one on the bare cut nearest the playhead, on the
      // selected clip's track — so selection plus playhead is precise control.
      // Both are set inside `applyFxPreset`, after the tab is open, because
      // switching tabs clears the selection.
      await applyFxPreset(session.page, "transition", transitionPresets[i], {
        selectElementId: mainIds[i],
        playheadMs: cut.endMs,
      });
      note(`transition "${transitionPresets[i]}" at cut ${i + 1} (${cut.endMs}ms)`);
    } catch (error) {
      note(`transition "${transitionPresets[i]}" not applied: ${(error as Error).message.slice(0, 160)}`);
    }
  }

  const effectPresets = ["Film Grain", "Vignette", "Bloom", "Chromatic Aberration", "Sepia", "Pixelate"];
  for (let i = 0; i < effectPresets.length; i++) {
    const atMs = onFrame(profile, D * (0.1 + i * 0.13));
    if (atMs >= D) break;
    try {
      await applyFxPreset(session.page, "effect", effectPresets[i], {
        selectElementId: null,
        playheadMs: atMs,
      });
      note(`effect "${effectPresets[i]}" at ${atMs}ms`);
    } catch (error) {
      note(`effect "${effectPresets[i]}" not applied: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  const after = await timelineDocument(session);
  for (const [id, element] of Object.entries(after)) {
    if (before[id] != null) continue;
    if (element.filetype === "transition") { transitions.push(id); record("transition", id, element.startTime, element.startTime + element.duration); }
    if (element.filetype === "effect") { effects.push(id); record("effect", id, element.startTime, element.startTime + element.duration); }
  }
  note(`${transitions.length} transitions and ${effects.length} effects placed through the fx grid`);

  // ------------------------------------------------- 9b. retiming and cuts
  //
  // Deliberately after the transitions. `set_clip_speed` with `ripple: false`
  // changes a clip's span without moving its neighbours, which opens a gap and
  // destroys the shared cut a transition needs — do it first and
  // `applyTransition` finds no bare cut on the track and silently places
  // nothing. These target the tail of the track, past the last transition.

  const retimeFrom = Math.max(transitionPresets.length + 1, mainIds.length - 4);
  const retimes = [[retimeFrom, 0.5], [retimeFrom + 1, 2], [retimeFrom + 2, 4]] as const;
  for (const [index, speed] of retimes) {
    if (mainIds[index] == null) continue;
    await agent(session, "set_clip_speed", { elementIds: [mainIds[index]], speed, ripple: false });
    record(`speed:${speed}`, mainIds[index], 0, 0);
    note(`speed ${speed}x on clip ${index}`);
  }

  const splitIndex = mainIds.length - 1;
  if (mainIds[splitIndex] != null) {
    const splitAt = onFrame(profile, splitIndex * slot + slot / 2);
    await agent(session, "split_clip", { elementId: mainIds[splitIndex], atMs: [splitAt] })
      .then(() => note(`split clip ${splitIndex} at ${splitAt}ms`))
      .catch((error) => note(`split refused: ${(error as Error).message.slice(0, 100)}`));
  }

  // -------------------------------------------------------- 10. z-order
  //
  // `priority` is derived from track order and never authored, so `move_track`
  // is the only way to change what covers what. Push the instrument track to
  // index 0 so nothing can ever be composited over a band a measurement reads.

  // `paintOrder` sorts by *descending* track index — "the highest index is the
  // bottom row, painted first" — so index 0 is the top of the z-order. Every
  // instrument track goes there, in order, so nothing the scenario places can
  // ever be composited over a band a measurement reads.
  for (const [rank, trackId] of instrumentTracks.entries()) {
    await agent(session, "move_track", { trackId, toIndex: rank })
      .catch((error) => note(`move_track refused: ${(error as Error).message.slice(0, 120)}`));
  }
  note(`${instrumentTracks.length} instrument tracks moved to the top of the z-order`);
  void instrumentTrack;

  await clearSelection(session.page);
  await agent(session, "set_playhead", { atMs: 0 });

  return { placed, byRole, tracks, transitions, effects, steps };
}

export type { ClipRow };
