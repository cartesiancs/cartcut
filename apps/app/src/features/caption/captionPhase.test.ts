import { describe, expect, it } from "vitest";
import { captionPhaseView } from "./captionPhase";
import { progressCopy } from "./transcribeSession";

describe("captionPhaseView", () => {
  it("draws no progress screen over the setup form or the caption list", () => {
    expect(captionPhaseView({ phase: "setup" })).toBeNull();
    expect(captionPhaseView({ phase: "live" })).toBeNull();
  });

  it("takes transcription's words from main's own stage", () => {
    const view = captionPhaseView({
      phase: "transcribing",
      stage: "downloading",
      fraction: 0.5,
    });
    expect(view?.title).toBe(progressCopy("downloading").title);
    expect(view?.percent).toBe(50);
  });

  it("rounds the bar to a whole percent", () => {
    expect(
      captionPhaseView({ phase: "transcribing", fraction: 0.1234 })?.percent,
    ).toBe(12);
  });

  it("reads a missing fraction as nothing done, not as done", () => {
    expect(captionPhaseView({ phase: "transcribing" })?.percent).toBe(0);
  });

  it("lets transcription be cancelled, and nothing else", () => {
    expect(captionPhaseView({ phase: "transcribing" })?.cancellable).toBe(true);
    expect(captionPhaseView({ phase: "sweeping" })?.cancellable).toBe(false);
    expect(captionPhaseView({ phase: "revealing" })?.cancellable).toBe(false);
  });

  // One ffmpeg decode with no intermediate output, and a reveal that is over in
  // about a second. A bar sitting at zero through real work says the work has
  // not started.
  it("shows no bar for the two phases nothing can estimate", () => {
    expect(captionPhaseView({ phase: "sweeping" })?.percent).toBeNull();
    expect(captionPhaseView({ phase: "revealing" })?.percent).toBeNull();
  });

  it("names every phase it draws, and never with an empty string", () => {
    for (const phase of ["transcribing", "sweeping", "revealing", "failed"] as const) {
      const view = captionPhaseView({ phase });
      expect(view).not.toBeNull();
      expect(view!.title.length).toBeGreaterThan(0);
      expect(view!.note.length).toBeGreaterThan(0);
    }
  });

  it("carries the reason a failure gives", () => {
    const view = captionPhaseView({
      phase: "failed",
      message: "The recogniser has no Korean model.",
    });
    expect(view?.note).toBe("The recogniser has no Korean model.");
    expect(view?.failed).toBe(true);
  });

  // A failure screen with no reason on it is indistinguishable from the app
  // having given up without being asked.
  it("says something when a failure arrives with nothing to say", () => {
    for (const message of [undefined, "", "   "]) {
      expect(
        captionPhaseView({ phase: "failed", message })?.note.trim().length,
      ).toBeGreaterThan(0);
    }
  });

  it("marks only the failure screen as a failure", () => {
    expect(captionPhaseView({ phase: "transcribing" })?.failed).toBe(false);
    expect(captionPhaseView({ phase: "sweeping" })?.failed).toBe(false);
    expect(captionPhaseView({ phase: "revealing" })?.failed).toBe(false);
  });
});
