import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";
import { Router, Response, Request } from "express";
import path from "path";

export const httpFilesystem = {
  getDirectory: async function (req: Request, res: Response) {
    const dir = req.query.dir;

    fs.readdir(dir, async (err, files) => {
      // Without this, `files` is undefined and `files.map` throws inside the
      // callback, so the request hangs until the client times out.
      if (err) {
        res.status(404).send({ message: String(err.message) });
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
        res.status(200).send(lists);
      } catch (error: any) {
        res.status(500).send({ message: String(error?.message ?? error) });
      }
    });
  },
  getFile: async function (req: Request, res: Response) {
    try {
      const filepath = req.query.path as string;
      if (!filepath) {
        res.status(400).send("path query parameter is required.");
        return;
      }

      const fileSplit = filepath.split("/");
      const directoryParts = fileSplit.slice(0, -1);
      const fileDirectory = directoryParts.join("/");

      res.sendFile(
        fileSplit[fileSplit.length - 1],
        { root: fileDirectory },
        (err) => {
          if (err) {
            console.error("Error sending file:", err);
            res.status(err.status || 500).send(err.message);
          }
        },
      );
    } catch (error) {
      console.error("Server error:", error);
      res.status(500).send("Internal server error");
    }
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
