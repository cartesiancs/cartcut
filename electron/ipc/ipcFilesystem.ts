import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";
import path from "path";
import { randomUUID } from "crypto";
import { app } from "electron";

export const ipcFilesystem = {
  getDirectory: async (event, dir) => {
    const result = new Promise((resolve, reject) => {
      fs.readdir(dir, async (err, files) => {
        // Without this, `files` is undefined and `files.map` throws inside the
        // callback, escaping the promise — it then never settles and the
        // renderer's `.then` and `.catch` both go uncalled.
        if (err) {
          reject(err);
          return;
        }

        try {
          let lists = {};

          const promises = files.map(async (file) => {
            const stat = await fsp.lstat(`${dir}/${file}`);
            const isDirectory = stat.isDirectory();

            lists[String(file)] = {
              isDirectory: isDirectory,
              title: file,
            };
          });

          await Promise.all(promises);
          resolve(lists);
        } catch (error) {
          reject(error);
        }
      });
    });

    return result;
  },
  makeDirectory: async (event, path, options) => {
    let mkdir = await fsp.mkdir(path, options);

    let status = mkdir == null ? false : true;
    return status;
  },

  emptyDirectorySync: async (event, path) => {
    let status = true;
    fse.emptyDirSync(path);
    return status;
  },

  removeDirectory: async (event, path) => {
    try {
      fs.rmSync(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      // `force` already swallows a missing path; anything left is a real
      // failure — a busy handle on Windows, say. The caller is the export's
      // "finish" handler cleaning up `renderAnimation/`, and a leftover temp
      // directory is not worth failing a finished render over, so report it
      // rather than rejecting the invoke.
      console.error("filesystem:removeDirectory", path, error);
      return false;
    }
  },

  writeFile: async (event, filename, data, options) => {
    fs.writeFile(filename, data, options, (error) => {
      if (error) {
        return false;
      }

      return true;
    });
  },

  /**
   * Write a file the caller named, creating its parent directories, and say
   * whether it worked.
   *
   * `writeFile` above cannot serve a template. It calls the **callback** form
   * of `fs.writeFile` and returns before the callback runs, so `await` resolves
   * ahead of the bytes and a failure comes back indistinguishable from success
   * — the defect `saveGeneratedAsset` below already documents. That is survivable
   * for a `.ngt` the user watched save; it is not survivable for an install,
   * which writes a dozen files and must know whether the folder it just made is
   * a template or a half of one.
   *
   * The `mkdir` matters just as much: a `.cttpl` carries `assets/clip.mp4`, and
   * `fs.writeFile` does not create `assets/`. Every asset in every imported
   * template would fail, one silent ENOENT at a time.
   *
   * Data arrives base64-encoded, which is what the renderer can hand across IPC
   * without a Buffer.
   */
  writeFileEnsured: async (event, filename: string, base64: string) => {
    try {
      await fsp.mkdir(path.dirname(filename), { recursive: true });
      await fsp.writeFile(filename, Buffer.from(base64, "base64"));
      return { status: true };
    } catch (error) {
      return { status: false, error: String(error) };
    }
  },

  readFile: async (event, filename) => {
    let data = await fsp.readFile(filename);
    return data;
  },

  existFile: async (event, path) => {
    try {
      await fsp.access(path);
      return true;
    } catch (err) {
      return false;
    }
  },

  removeFile: async (event, path) => {
    try {
      await fsp.unlink(path);
      return true;
    } catch (err) {
      return false;
    }
  },

  /**
   * Write a renderer-generated asset — a rasterised title, say — and hand back
   * where it landed.
   *
   * Neither existing option would do. `writeFile` above calls the *callback*
   * form of `fs.writeFile` and returns before it runs, so `await` resolves
   * ahead of the bytes reaching disk and a failure is reported as success;
   * pointing an element at a path that comes back from it races the write.
   * `ipcStream.saveBufferToTempFile` is correct but writes into
   * `app.getPath("temp")`, and a `.ngt` stores only paths — so a rasterised
   * title would quietly turn into an empty clip the first time the OS swept
   * its temp directory, with `renderImage` drawing nothing and saying nothing.
   *
   * `userData/generated/` survives that, and survives a reboot. It does not
   * survive the project being carried to another machine — and that used to be
   * true of all media, but is not any more: `features/project/assetsFile.ts`
   * records a relative path for anything sitting inside the `.ngt`'s own
   * folder, so a project folder can now be handed to someone else intact.
   * Nothing written here is ever inside that folder, so a rasterised title is
   * specifically what a carried project still loses. That makes this the first
   * thing a "collect files" feature would have to move.
   */
  saveGeneratedAsset: async (event, buffer, ext = "png") => {
    try {
      const safeExt = String(ext).replace(/[^a-z0-9]/gi, "") || "png";
      const dir = path.join(app.getPath("userData"), "generated");
      await fsp.mkdir(dir, { recursive: true });

      const filePath = path.join(dir, `${randomUUID()}.${safeExt}`);
      await fsp.writeFile(filePath, Buffer.from(buffer));

      return { status: true, path: filePath };
    } catch (error) {
      return { status: false, error: String(error) };
    }
  },
};
