/**
 * The last few hundred lines each extension printed.
 *
 * A ring rather than a file. An extension's log is read in one place, the
 * Extensions panel, while something is going wrong; keeping it in memory means
 * there is no file to rotate, no disk to fill from a `console.log` in a render
 * loop, and nothing left behind when the app closes. An author who wants a
 * durable log writes one through `cartcut.fs`.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogLine = {
  at: number;
  level: LogLevel;
  text: string;
};

/** Long enough to hold an activation failure and what led to it. */
export const LOG_CAPACITY = 500;
/** One line longer than this is a dump, not a log line. */
export const MAX_LINE_CHARS = 4_000;

export type LogRing = {
  push(id: string, level: LogLevel, text: string): LogLine;
  lines(id: string): LogLine[];
  clear(id: string): void;
};

export function createLogRing(capacity: number = LOG_CAPACITY): LogRing {
  const byExtension = new Map<string, LogLine[]>();

  return {
    push(id, level, text) {
      const line: LogLine = {
        at: Date.now(),
        level,
        text: text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + " [truncated]" : text,
      };
      const lines = byExtension.get(id) ?? [];
      lines.push(line);
      if (lines.length > capacity) {
        lines.splice(0, lines.length - capacity);
      }
      byExtension.set(id, lines);
      return line;
    },

    lines(id) {
      return [...(byExtension.get(id) ?? [])];
    },

    clear(id) {
      byExtension.delete(id);
    },
  };
}

/**
 * What an extension passed to `ctx.log.info(...)`, as one string.
 *
 * Everything crosses a structured clone, so an object arrives as an object and
 * has to be rendered here rather than by `console.log`'s own formatter. A
 * value that cannot be serialised becomes its type name rather than throwing:
 * a log call must never be the thing that breaks an extension.
 */
export function formatLogArgs(args: readonly unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      if (value instanceof Error) {
        return value.stack ?? value.message;
      }
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    })
    .join(" ");
}
