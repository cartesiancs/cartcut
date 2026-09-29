/**
 * Asking the bundled ffprobe what a file is, for the Show Info dialog.
 *
 * Spawned directly, never through `fluent-ffmpeg`, whose capability parser
 * cannot read this ffmpeg's output (CLAUDE.md, "Known rough edges"). The
 * binary is a parameter, so `mediaInfoProbe.test.ts` runs the real one.
 *
 * The path comes from the renderer, so three things keep it a local file:
 * it must be absolute (a `http://` string is not), ffprobe is handed it behind
 * a `file:` prefix so no other protocol can be named, and `-protocol_whitelist
 * file` stops a local playlist from opening a network one on our behalf.
 *
 * Never rejects. Every failure is a `reason` the dialog has a sentence for.
 */

import { spawn, type ChildProcess } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { parseProbe, type MediaInfoResult } from "./mediaInfo";

/** A local probe reads the header and a few packets; this is a wedged one. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Far above any real probe (a two-stream file is about 5KB), and low enough
 * that a pathological file with thousands of streams cannot grow the main
 * process's heap without bound.
 */
export const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ProbeDeps = {
  spawn: (bin: string, args: string[]) => ChildProcess;
  stat: (file: string) => Promise<{ isFile(): boolean }>;
  timeoutMs: number;
};

const defaultDeps: ProbeDeps = {
  // stderr ignored rather than piped and left unread: a full pipe would stall
  // the child, and `-v error` output is not something the dialog shows.
  spawn: (bin, args) => spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] }),
  stat: (file) => fsp.stat(file),
  timeoutMs: PROBE_TIMEOUT_MS,
};

export function isProbeablePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

export function probeArgs(fsPath: string): string[] {
  return [
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    `file:${fsPath}`,
  ];
}

type RunResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "unreadable" | "timeout" };

function run(bin: string, args: string[], deps: ProbeDeps): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = deps.spawn(bin, args);
    } catch {
      finish({ ok: false, reason: "unreadable" });
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, deps.timeoutMs);

    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROBE_OUTPUT_BYTES) {
        child.kill();
        finish({ ok: false, reason: "unreadable" });
        return;
      }
      chunks.push(chunk);
    });
    // A missing binary arrives here as ENOENT, not as a throw from `spawn`.
    child.on("error", () => finish({ ok: false, reason: "unreadable" }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, stdout: Buffer.concat(chunks).toString("utf8") }
          : { ok: false, reason: "unreadable" },
      ),
    );
  });
}

export async function probeMediaInfo(
  ffprobe: string,
  fsPath: unknown,
  deps: ProbeDeps = defaultDeps,
): Promise<MediaInfoResult> {
  if (!isProbeablePath(fsPath)) {
    return { ok: false, reason: "invalid" };
  }

  // Stat first, so a moved file says "not found" rather than ffprobe's
  // generic failure, which is the one case the dialog can say something
  // useful about.
  try {
    if (!(await deps.stat(fsPath)).isFile()) {
      return { ok: false, reason: "invalid" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
    };
  }

  const result = await run(ffprobe, probeArgs(fsPath), deps);
  if (!result.ok) {
    return result;
  }
  try {
    return { ok: true, info: parseProbe(JSON.parse(result.stdout)) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
