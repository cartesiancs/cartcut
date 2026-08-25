import getSystemFonts from "get-system-fonts";
import path from "path";
import isDev from "electron-is-dev";
import fs from "fs";
import * as fsp from "fs/promises";

const resourcesPath = isDev == true ? "." : process.resourcesPath;
const LOCAL_FONT_PATH = path.join(`${resourcesPath}/assets/fonts`);

/**
 * The Google Fonts bundled for the text-preset panel.
 *
 * A subdirectory rather than more files in `assets/fonts`, so `getLocalFontList`
 * — which skips directories — keeps returning exactly what it always did.
 */
const PRESET_FONT_PATH = path.resolve(LOCAL_FONT_PATH, "google");

type FontList = {
  path: string;
  type: string;
  name: string;
};

export const fontLib = {
  getFontList: async (event) => {
    try {
      const files = await getSystemFonts();
      let lists: FontList[] = [];
      for (let index = 0; index < files.length; index++) {
        const fontPath = files[index];
        const fontSplitedPath = fontPath.split(path.sep);
        const fontType =
          fontSplitedPath[fontSplitedPath.length - 1].split(".")[1];
        const fontName =
          fontSplitedPath[fontSplitedPath.length - 1].split(".")[0];
        lists.push({
          path: fontPath.split(path.sep).join("/"),
          type: fontType,
          name: fontName,
        });
      }
      return { status: 1, fonts: lists };
    } catch (error) {
      return { status: 0 };
    }
  },

  getLocalFontList: async (event) => {
    try {
      const result = new Promise((resolve, reject) => {
        fs.readdir(LOCAL_FONT_PATH, async (err, files) => {
          let lists: any = [];

          const promises = files.map(async (file) => {
            const stat = await fsp.lstat(`${LOCAL_FONT_PATH}/${file}`);
            const isDirectory = stat.isDirectory();

            if (!isDirectory) {
              lists.push({
                path: `${LOCAL_FONT_PATH}/${file}`,
                type: file.split(".")[file.split(".").length - 1],
                name: file.split(".")[file.split(".").length - 2],
              });
            }
          });

          await Promise.all(promises);
          resolve({ status: 1, fonts: lists });
        });
      });

      return result;
    } catch (error) {
      return { status: 0 };
    }
  },

  /**
   * The bundled Google Fonts, as `@font-face`-ready entries.
   *
   * Two things this does that `getLocalFontList` does not, both of which matter
   * downstream:
   *
   *  - The path is **absolute**. In dev `resourcesPath` is `"."`, so the older
   *    handler returns `./assets/fonts/…`, and `ensureFontFace` turns that into
   *    `url("file://./assets/…")` — which resolves against nothing and silently
   *    drops the face. `path.resolve` at module load makes dev and packaged
   *    builds agree.
   *  - The extension is split on the *last* dot, so `Bebas-Neue-Regular.ttf`
   *    style names survive. The stem becomes the CSS family, and that family is
   *    what the element stores in `fontname`.
   *
   * A missing directory is not an error: a fresh checkout that has not fetched
   * the fonts yet should show an empty preset panel, not fail to start.
   */
  getPresetFontList: async (event?) => {
    try {
      const files = await fsp.readdir(PRESET_FONT_PATH);
      const lists: FontList[] = [];

      for (const file of files) {
        const dot = file.lastIndexOf(".");
        if (dot <= 0) {
          continue;
        }
        const type = file.slice(dot + 1).toLowerCase();
        if (type !== "ttf" && type !== "otf" && type !== "woff2") {
          continue;
        }

        lists.push({
          path: path.join(PRESET_FONT_PATH, file).split(path.sep).join("/"),
          type: type,
          name: file.slice(0, dot),
        });
      }

      lists.sort((a, b) => a.name.localeCompare(b.name));
      return { status: 1, fonts: lists };
    } catch (error) {
      return { status: 0, fonts: [] };
    }
  },
};
