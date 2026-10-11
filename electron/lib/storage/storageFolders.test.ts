import { describe, expect, it } from "vitest";

import { STORAGE_FOLDERS, isStorageFolder } from "./storageFolders";

describe("isStorageFolder", () => {
  it("accepts each named folder", () => {
    for (const folder of STORAGE_FOLDERS) {
      expect(isStorageFolder(folder)).toBe(true);
    }
  });

  it("refuses paths, prototype keys and anything that is not a string", () => {
    for (const value of ["../x", "/tmp", "", "constructor", "toString", "APPDATA", undefined, null, 1, {}]) {
      expect(isStorageFolder(value)).toBe(false);
    }
  });
});
