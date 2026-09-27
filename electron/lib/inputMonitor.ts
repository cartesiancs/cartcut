/**
 * Running the native input sidecar: spawn, read NDJSON, kill.
 *
 * A thin wrapper by design. The sidecar reports only *what* the mouse did, so
 * there is no geometry here and no clock here. `recordSession.ts` stamps each
 * event with the same `elapsedMs` its cursor sampler uses and reads the position
 * through the same `capturePointNow`. See `native/cartcut-input/README.md` for
 * why the coordinates are not the sidecar's to give.
 *
 * `createLineReader` is `speechStt.ts`'s, reused rather than copied: a pipe
 * splits wherever it likes and keeping the tail is the whole trick.
 */

import { spawn, type ChildProcess } from "child_process";
import log from "electron-log";
import { createLineReader } from "./speechStt.js";
import {
  INPUT_BIN_PATH,
  inputMonitorUnavailableReason,
  isInputMonitorAvailable,
} from "./inputBin.js";

export type InputKind = "down" | "up" | "drag" | "scroll";

const KINDS = new Set<string>(["down", "up", "drag", "scroll"]);

export type InputMonitor = { stop(): void };

/**
 * Start watching, or answer `null`.
 *
 * `null` is not a failure and the caller must not treat it as one: a build with
 * no sidecar, or a platform without one, records the cursor track alone and
 * plans zooms from dwell exactly as it did before clicks existed.
 */
export function startInputMonitor(
  onEvent: (kind: InputKind, button: number) => void,
): InputMonitor | null {
  const reason = inputMonitorUnavailableReason();
  if (!isInputMonitorAvailable()) {
    log.info("[record]", reason ?? "no input monitor");
    return null;
  }

  let child: ChildProcess;
  try {
    child = spawn(INPUT_BIN_PATH, ["watch"], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    log.warn("[record] could not start the input monitor", error);
    return null;
  }

  const reader = createLineReader((line) => {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      // A garbled line is worth nothing and is not itself a failure. dyld writes
      // to stderr, so anything unparseable here is a bug in the sidecar rather
      // than noise from the loader.
      return;
    }

    if (event?.type === "ready") {
      // Logged rather than acted on. Whether a mouse monitor needs accessibility
      // trust is the one open question in this feature, and this line is where
      // the answer shows up on a real machine: see the sidecar's README.
      log.info(
        `[record] input monitor ready (installed=${event.installed}, trusted=${event.trusted})`,
      );
      return;
    }

    if (event?.type === "event" && KINDS.has(event.kind)) {
      onEvent(event.kind, Number.isFinite(event.button) ? Number(event.button) : 0);
      return;
    }

    if (event?.type === "error") {
      log.warn("[record] input monitor:", event.code, event.message);
    }
  });

  child.stdout?.on("data", (chunk: Buffer) => reader.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => {
    log.warn("[record] input monitor stderr:", chunk.toString().trim());
  });

  child.on("error", (error) => {
    log.warn("[record] input monitor failed", error);
  });

  return {
    stop() {
      // `end()` before `kill()`: the sidecar exits on a closed stdin by itself,
      // which is the path its own suite exercises, and a signal is the backstop
      // rather than the mechanism.
      try {
        child.stdin?.end();
      } catch {
        // Already gone.
      }
      child.kill();
    },
  };
}
