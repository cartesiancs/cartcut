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
    fs.rmSync(path, { recursive: true, force: true });

    return status;
  },

  writeFile: async (event, filename, data, options) => {
    fs.writeFile(filename, data, options, (error) => {
      if (error) {
        return false;
      }

      return true;
    });
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
   * survive the project being carried to another machine, but no media in this
   * app does — everything is referenced by absolute path.
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
