/**
 * What the panel says, checked as data.
 *
 * The distinctions here are the ones a screenshot would not catch: a bar that
 * should be a spinner, a Cancel offered on a phase that cannot be cancelled,
 * and the sentence that has to state 400MB before anything is downloaded.
 */

import { describe, expect, it } from "vitest";

import { downloadPrompt, megabytes, ttsPhaseView } from "./ttsPhase";

describe("megabytes", () => {
  it("rounds to whole megabytes", () => {
    expect(megabytes(401_276_744)).toBe(401);
    expect(megabytes(0)).toBe(0);
  });
});

describe("downloadPrompt", () => {
  /** The one thing a user must not find out afterwards. */
  it("states the size before anything is downloaded", () => {
    const prompt = downloadPrompt(401_276_744);
    expect(prompt).toContain("401 MB");
    expect(prompt).toContain("once");
  });

  it("offers to resume rather than restart when part of it is here", () => {
    const prompt = downloadPrompt(400_000_000, 300_000_000);
    expect(prompt).toContain("100 MB left");
    expect(prompt).toContain("picks up where it stopped");
  });

  it("does not claim a negative remainder", () => {
    expect(downloadPrompt(100, 500)).toContain("0 MB left");
  });
});

describe("ttsPhaseView", () => {
  it("draws the ordinary body when there is nothing to report", () => {
    expect(ttsPhaseView({ phase: "ready" })).toBe(null);
    expect(ttsPhaseView({ phase: "needsModel" })).toBe(null);
  });

  it("spins rather than sitting at zero while the model loads", () => {
    const view = ttsPhaseView({ phase: "speaking", stage: "loading", fraction: 0 })!;
    // A bar at zero while real work happens says the work has not started.
    expect(view.percent).toBe(null);
    expect(view.title).toContain("Loading");
    expect(view.note).not.toBe("");
  });

  it("shows a real bar once it is synthesising", () => {
    const view = ttsPhaseView({
      phase: "speaking",
      stage: "synthesizing",
      fraction: 0.42,
    })!;
    expect(view.percent).toBe(42);
    expect(view.cancellable).toBe(true);
  });

  it("says it is waiting when the job is queued behind another", () => {
    const view = ttsPhaseView({ phase: "speaking", stage: "queued", fraction: null })!;
    expect(view.title).toContain("Waiting");
    expect(view.percent).toBe(null);
  });

  it("can be cancelled while downloading and while speaking, but not after", () => {
    expect(ttsPhaseView({ phase: "downloading", fraction: 0.1 })!.cancellable).toBe(true);
    expect(ttsPhaseView({ phase: "speaking", fraction: 0.1 })!.cancellable).toBe(true);
    expect(ttsPhaseView({ phase: "checking" })!.cancellable).toBe(false);
    expect(ttsPhaseView({ phase: "failed", message: "x" })!.cancellable).toBe(false);
  });

  it("carries the failure message through rather than swallowing it", () => {
    const view = ttsPhaseView({ phase: "failed", message: "Checksum did not match" })!;
    expect(view.failed).toBe(true);
    expect(view.note).toBe("Checksum did not match");
  });

  it("clamps a fraction that arrives outside its range", () => {
    expect(ttsPhaseView({ phase: "downloading", fraction: 1.5 })!.percent).toBe(100);
    expect(ttsPhaseView({ phase: "downloading", fraction: -1 })!.percent).toBe(0);
    expect(ttsPhaseView({ phase: "downloading", fraction: NaN })!.percent).toBe(null);
  });

  it("names the size while downloading", () => {
    const view = ttsPhaseView({
      phase: "downloading",
      fraction: 0.2,
      totalBytes: 401_276_744,
    })!;
    expect(view.note).toContain("401 MB");
  });
});
