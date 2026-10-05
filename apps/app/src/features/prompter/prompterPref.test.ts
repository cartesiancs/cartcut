import { describe, expect, it } from "vitest";

import {
  type PrompterStoragePort,
  loadPrompterSpeed,
  savePrompterSpeed,
} from "./prompterPref";
import { DEFAULT_PROMPTER_SPEED, MAX_PROMPTER_SPEED } from "./prompterScroll";

function memoryPort(initial: string | null = null) {
  let stored = initial;
  const port: PrompterStoragePort = {
    read: () => stored,
    write: (value) => {
      stored = value;
    },
  };
  return { port, stored: () => stored };
}

const throwing: PrompterStoragePort = {
  read: () => {
    throw new Error("SecurityError");
  },
  write: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("prompterPref", () => {
  it("round-trips a speed", () => {
    const memory = memoryPort();
    savePrompterSpeed(memory.port, 1.7);
    expect(loadPrompterSpeed(memory.port)).toBe(1.7);
  });

  it("starts at the default when nothing was saved", () => {
    expect(loadPrompterSpeed(memoryPort().port)).toBe(DEFAULT_PROMPTER_SPEED);
  });

  it("clamps a stored value that is out of range", () => {
    expect(loadPrompterSpeed(memoryPort("40").port)).toBe(MAX_PROMPTER_SPEED);
  });

  it("falls back to the default on anything unreadable", () => {
    expect(loadPrompterSpeed(memoryPort("not json").port)).toBe(
      DEFAULT_PROMPTER_SPEED,
    );
    expect(loadPrompterSpeed(memoryPort('"fast"').port)).toBe(
      DEFAULT_PROMPTER_SPEED,
    );
  });

  it("survives storage that throws on read and on write", () => {
    expect(loadPrompterSpeed(throwing)).toBe(DEFAULT_PROMPTER_SPEED);
    expect(() => savePrompterSpeed(throwing, 2)).not.toThrow();
  });

  it("stores the coerced value, never a raw one", () => {
    const memory = memoryPort();
    savePrompterSpeed(memory.port, 1.2999999);
    expect(memory.stored()).toBe("1.3");
  });
});
