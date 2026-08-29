/**
 * What the agent sees, pinned.
 *
 * The tool list is an API: renaming a tool silently breaks every saved prompt
 * and skill that names it, and a duplicate registration would throw only once
 * the app was running. Both are cheap to catch here.
 *
 * The committed name list is the point. A new tool is a one-line diff to it,
 * which puts the addition in front of a reviewer; a rename shows up as a
 * removal plus an addition, which is what it actually is.
 */

import { describe, it, expect } from "vitest";
import { registerToolsWith } from "../tools";
import { EASINGS, PRESETS, type Registrar, type ToolConfig } from "./define";

/** Every tool the MCP server exposes, in registration order. */
const EXPECTED = [
  // reading
  "get_project_overview",
  "list_clips",
  "analyze_audio",
  "get_contact_sheet",
  "get_clip",
  "get_keyframes",
  "list_assets",
  "list_fonts",
  "get_transcript",
  // cutting
  "remove_ranges",
  "split_clip",
  "trim_clip",
  "move_clips",
  "delete_clips",
  "duplicate_clips",
  "set_clip_speed",
  // adding
  "add_media",
  "add_shape",
  // text and properties
  "add_subtitles",
  "add_text",
  "update_clip",
  "set_text_font",
  "rasterize_text",
  "set_video_filters",
  // tracks
  "add_track",
  "remove_track",
  "move_track",
  // animation
  "apply_animation_preset",
  "set_animation",
  "add_keyframes",
  "remove_keyframes",
  // transitions and effects
  "list_transition_presets",
  "list_effect_presets",
  "list_cuts",
  "add_transition",
  "set_transition",
  "remove_transition",
  "add_effect",
  "set_effect",
  "get_fx",
  // groups
  "group_clips",
  "ungroup",
  "set_clip_parent",
  // meta
  "set_playhead",
  "select_clips",
  "get_selection",
  "undo",
  "redo",
  // planning
  "get_edit_brief",
  "apply_edit_plan",
];

type Registered = { name: string; config: ToolConfig };

function collect(): Registered[] {
  const registered: Registered[] = [];
  const define: Registrar = (name, config) => {
    registered.push({ name, config });
  };
  registerToolsWith(define);
  return registered;
}

describe("the registered tool list", () => {
  it("is exactly what is committed here", () => {
    expect(collect().map((t) => t.name)).toEqual(EXPECTED);
  });

  it("registers no name twice", () => {
    const names = collect().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses snake_case names throughout", () => {
    for (const { name } of collect()) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("every tool is usable as declared", () => {
  it("has a title and a description", () => {
    for (const { name, config } of collect()) {
      expect(config.title, `${name} has no title`).toBeTruthy();
      expect(config.description, `${name} has no description`).toBeTruthy();
    }
  });

  it("says whether it mutates the project", () => {
    for (const { name, config } of collect()) {
      expect(
        config.annotations?.readOnlyHint,
        `${name} does not declare readOnlyHint`,
      ).toBeTypeOf("boolean");
    }
  });

  it("marks the tools that destroy work", () => {
    const destructive = collect()
      .filter((t) => t.config.annotations?.destructiveHint === true)
      .map((t) => t.name);

    // These are the three that can lose something the user cannot get back
    // with a single undo: clips, a whole track, or a group's animation.
    expect(destructive.sort()).toEqual(["delete_clips", "remove_track", "ungroup"]);
  });

  it("declares an input schema, even when empty", () => {
    for (const { name, config } of collect()) {
      expect(config.inputSchema, `${name} has no inputSchema`).toBeDefined();
    }
  });

  it("advertises exactly the presets the renderer has", async () => {
    const { presetNames } = await import(
      "../../../apps/app/src/features/animation/presets"
    );
    expect([...PRESETS].sort()).toEqual([...presetNames()].sort());
  });

  it("advertises exactly the easings the renderer can resolve", async () => {
    // `EASINGS` is a hand copy of the renderer's list, because `.tsconfig`
    // forbids importing across that boundary. Vitest has no such constraint, so
    // the copy is pinned here: drift becomes a failing test rather than a curve
    // the schema offers and `add_keyframes` then refuses.
    const { easingNames } = await import(
      "../../../apps/app/src/features/animation/easing"
    );
    expect([...EASINGS].sort()).toEqual([...easingNames()].sort());
  });

  it("keeps descriptions short enough to live in every request's context", () => {
    // Tool definitions are sent on every turn. `remove_ranges` and
    // `get_transcript` earn their length; nothing should be running away.
    for (const { name, config } of collect()) {
      expect(
        (config.description ?? "").length,
        `${name}'s description is very long`,
      ).toBeLessThan(1200);
    }
  });
});
