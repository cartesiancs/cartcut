import { describe, expect, it } from "vitest";
import { DEFAULT_ASSET_SORT } from "./assetSort";
import {
  SortStoragePort,
  loadAssetSort,
  saveAssetSort,
} from "./assetSortPref";

function memoryPort(initial: string | null = null) {
  let stored = initial;
  const port: SortStoragePort = {
    read: () => stored,
    write: (value) => {
      stored = value;
    },
  };
  return { port, stored: () => stored };
}

const throwing: SortStoragePort = {
  read: () => {
    throw new Error("SecurityError");
  },
  write: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("assetSortPref", () => {
  it("round-trips a choice", () => {
    const { port } = memoryPort();
    saveAssetSort(port, { key: "modified", direction: "asc" });
    expect(loadAssetSort(port)).toEqual({ key: "modified", direction: "asc" });
  });

  it("stores only the key and the direction", () => {
    const { port, stored } = memoryPort();
    saveAssetSort(port, {
      key: "size",
      direction: "desc",
      extra: 1,
    } as never);
    expect(JSON.parse(stored() as string)).toEqual({
      key: "size",
      direction: "desc",
    });
  });

  it("starts from the default with nothing stored", () => {
    expect(loadAssetSort(memoryPort().port)).toBe(DEFAULT_ASSET_SORT);
  });

  it("starts from the default for a value that is not JSON", () => {
    expect(loadAssetSort(memoryPort("{nope").port)).toBe(DEFAULT_ASSET_SORT);
  });

  it("starts from the default for a key it does not know", () => {
    expect(
      loadAssetSort(memoryPort('{"key":"tags","direction":"asc"}').port),
    ).toEqual(DEFAULT_ASSET_SORT);
  });

  it("survives storage that throws on read and on write", () => {
    expect(loadAssetSort(throwing)).toBe(DEFAULT_ASSET_SORT);
    expect(() =>
      saveAssetSort(throwing, { key: "size", direction: "desc" }),
    ).not.toThrow();
  });
});
