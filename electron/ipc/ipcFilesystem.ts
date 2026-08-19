import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";

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
};
