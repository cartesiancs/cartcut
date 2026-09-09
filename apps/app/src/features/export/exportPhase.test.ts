import { describe, expect, it } from "vitest";
import {
  isExportBusy,
  nextPhase,
  type ExportEvent,
  type ExportPhase,
} from "./exportPhase";

const PHASES: ExportPhase[] = ["idle", "running", "finalizing", "cancelling"];
const EVENTS: ExportEvent[] = [
  "start",
  "frameLoopDone",
  "cancelRequested",
  "settled",
];

/** Every cell that moves. Everything else must decline. */
const MOVES: Record<string, ExportPhase> = {
  "idle/start": "running",
  "running/frameLoopDone": "finalizing",
  "running/cancelRequested": "cancelling",
  "running/settled": "idle",
  "finalizing/cancelRequested": "cancelling",
  "finalizing/settled": "idle",
  "cancelling/settled": "idle",
};

describe("nextPhase", () => {
  it("moves exactly where the table says and nowhere else", () => {
    for (const phase of PHASES) {
      for (const event of EVENTS) {
        const expected = MOVES[`${phase}/${event}`];
        expect(nextPhase(phase, event), `${phase} + ${event}`).toBe(
          expected ?? phase,
        );
      }
    }
  });

  it("returns its input BY IDENTITY when the event does not apply", () => {
    // Not merely equal. `exportStore.dispatch` compares with `Object.is` and
    // notifies nobody when they match, which is what makes a duplicate
    // `settled` — the click handler's `finally` and `render:v2:cancelled` race
    // each other — cost no repaint.
    for (const phase of PHASES) {
      for (const event of EVENTS) {
        if (MOVES[`${phase}/${event}`] != null) continue;
        expect(nextPhase(phase, event)).toBe(phase);
      }
    }
  });

  it("admits cancelling out of finalizing, because killing FFmpeg mid-mux works", () => {
    expect(nextPhase("finalizing", "cancelRequested")).toBe("cancelling");
  });

  it("refuses to start from cancelling — the double-click this phase exists for", () => {
    // The renderer aborts instantly; the main process is still reaping FFmpeg
    // and `ipcRenderV2.start` would throw "An export is already running".
    expect(nextPhase("cancelling", "start")).toBe("cancelling");
  });

  it("settles from every phase", () => {
    for (const phase of PHASES) {
      expect(nextPhase(phase, "settled")).toBe("idle");
    }
  });

  it("reaches idle again from a full cancel", () => {
    const cancelling = nextPhase(nextPhase("idle", "start"), "cancelRequested");
    expect(cancelling).toBe("cancelling");
    expect(nextPhase(cancelling, "settled")).toBe("idle");
  });
});

describe("isExportBusy", () => {
  it("is true for every phase but idle", () => {
    expect(isExportBusy("idle")).toBe(false);
    expect(isExportBusy("running")).toBe(true);
    expect(isExportBusy("finalizing")).toBe(true);
    // Busy: the encoder is not free until main confirms the kill.
    expect(isExportBusy("cancelling")).toBe(true);
  });
});
