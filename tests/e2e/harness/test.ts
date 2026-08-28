/**
 * The suite's own `test`, with the app and its context wired in as fixtures.
 *
 * The profile arrives through `project.metadata.profile` rather than an
 * environment variable the specs read for themselves, so `--project=smoke` is
 * the single place scale is chosen and nothing downstream can disagree about
 * which one is running. It is also mirrored into `process.env` because a few
 * helpers (the artifact writer, the fixture loader) are reached from places
 * that have no `testInfo`.
 */

import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import {
  activeProfile,
  instrumentsFor,
  loadFixtures,
  OUT_DIR,
  profileNamed,
  type FixtureManifest,
  type InstrumentSet,
  type Profile,
} from "./paths";
import { launchApp, type AppSession } from "./launch";

export type E2EFixtures = {
  profile: Profile;
  fixtures: FixtureManifest;
  instruments: InstrumentSet;
  /** Per-test directory for diagnostic artifacts. */
  artifactDir: string;
  session: AppSession;
};

export const test = base.extend<E2EFixtures>({
  profile: async ({}, use, testInfo) => {
    const name = (testInfo.project.metadata as { profile?: string })?.profile ?? "full";
    // Helpers without access to testInfo read this.
    process.env.CARTCUT_E2E_PROFILE = name;
    await use(profileNamed(name));
  },

  fixtures: async ({ profile }, use) => {
    void profile;
    await use(loadFixtures());
  },

  instruments: async ({ profile }, use) => {
    await use(instrumentsFor(profile));
  },

  artifactDir: async ({ profile }, use, testInfo) => {
    const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60);
    const dir = path.join(OUT_DIR, profile.name, slug);
    fs.mkdirSync(dir, { recursive: true });
    await use(dir);
  },

  session: async ({ profile }, use, testInfo) => {
    void profile;
    const session = await launchApp();
    await use(session);

    // A renderer that logged errors during an export is worth knowing about
    // even when every assertion passed — it is usually the first sign of a
    // decoder giving up under load. Recorded rather than asserted, because the
    // page also logs benign errors (a missing CDN font, say) that would turn
    // every run red for no reason.
    if (session.problems.length > 0) {
      await testInfo.attach("renderer-problems.txt", {
        body: session.problems.join("\n"),
        contentType: "text/plain",
      });
    }
    await session.close();
  },
});

export { expect, activeProfile };
