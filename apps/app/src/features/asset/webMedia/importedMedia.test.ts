import { describe, expect, it } from "vitest";
import { mergeImported, type PickedFile } from "./importedMedia";
import { pickedMediaPath } from "./mediaRegistry";
import { mediaKindOf } from "../../element/mediaElement";

function pick(name: string, size = 10, lastModified = 1_700_000_000_000, type = ""): PickedFile {
  return { file: { name, size, lastModified, type } };
}

function registrar() {
  let n = 0;
  const calls: string[] = [];
  const register = (p: PickedFile) => {
    calls.push(p.file.name);
    n += 1;
    return pickedMediaPath(`blob:http://localhost/${n}`, p.file.name, p.file.type);
  };
  return { register, calls };
}

describe("mergeImported", () => {
  it("lists every new file with its blob path, size and date", () => {
    const { register } = registrar();
    const { list, paths } = mergeImported([], [pick("a.mp4", 5), pick("b.png", 7)], register);

    expect(paths).toEqual(["blob:http://localhost/1#a.mp4", "blob:http://localhost/2#b.png"]);
    expect(list.map((e) => [e.name, e.path, e.size, e.modifiedMs, e.isDirectory])).toEqual([
      ["a.mp4", paths[0], 5, 1_700_000_000_000, false],
      ["b.png", paths[1], 7, 1_700_000_000_000, false],
    ]);
  });

  it("keeps the first entry for a file picked again, and registers it once", () => {
    const { register, calls } = registrar();
    const first = mergeImported([], [pick("a.mp4")], register);
    const again = mergeImported(first.list, [pick("a.mp4")], register);

    expect(again.list).toBe(first.list);
    expect(again.paths).toEqual(first.paths);
    expect(calls).toEqual(["a.mp4"]);
  });

  it("tells apart two files that only share a name", () => {
    const { register } = registrar();
    const first = mergeImported([], [pick("clip.mp4", 10)], register);
    const second = mergeImported(first.list, [pick("clip.mp4", 11)], register);

    expect(second.list).toHaveLength(2);
    expect(new Set(second.list.map((e) => e.path)).size).toBe(2);
  });

  it("collapses a file picked twice in one go", () => {
    const { register, calls } = registrar();
    const { list, paths } = mergeImported([], [pick("a.mp4"), pick("a.mp4")], register);

    expect(list).toHaveLength(1);
    expect(paths).toEqual([list[0].path, list[0].path]);
    expect(calls).toHaveLength(1);
  });

  it("shows the name the path carries, so the tile and the probe agree on the kind", () => {
    const { register } = registrar();
    const { list } = mergeImported([], [pick("video", 3, 1, "video/mp4")], register);

    expect(list[0].name).toBe("video.mp4");
    expect(mediaKindOf(list[0].path)).toBe("video");
  });

  it("leaves out a date the file does not report", () => {
    const { register } = registrar();
    const { list } = mergeImported([], [pick("a.mp4", 3, 0)], register);

    expect("modifiedMs" in list[0]).toBe(false);
  });
});
