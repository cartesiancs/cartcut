import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";
import axios from "axios";
import Store from "electron-store";
import path from "path";
import {
  isMcpRunning,
  mcpAddCommand,
  mcpToken,
  mcpUrl,
  startMcpServer,
} from "../mcp/server";
import { fileBlob } from "../mcp/transcribe";
const store = new Store();

const llmPromptfilePath = path.join(
  __dirname,
  "..",
  "..",
  "assets",
  "llm",
  "textPrompt.txt",
);

export const ipcAi = {
  stt: async (evt, filepath) => {
    try {
      if (!filepath) {
        return { status: 0 };
      }

      const OPENAI_API_KEY = store.get("ai_openai_key");
      if (OPENAI_API_KEY == undefined) {
        return { status: 0 };
      }

      // A `fs.ReadStream` inside a plain object is not a multipart body — the
      // header said `multipart/form-data` but axios serialised the object as
      // JSON, and the stream became `{}`. Every call failed. A real `FormData`
      // is what axios needs in order to build the parts.
      const form = new FormData();
      form.append("file", fileBlob(filepath, "audio/wav"), path.basename(filepath));
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");

      const response = await axios.post(
        "https://api.openai.com/v1/audio/transcriptions",
        form,
        {
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        },
      );

      return { status: 1, text: response.data };
    } catch (error) {
      console.error(error);
    }
  },

  text: async (evt, model, question) => {
    try {
      if (!question) {
        return { status: 0 };
      }

      const OPENAI_API_KEY = store.get("ai_openai_key");
      if (OPENAI_API_KEY == undefined) {
        return { status: 0 };
      }

      const data = fs.readFileSync(llmPromptfilePath, "utf8");

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: model,
          messages: [
            { role: "system", content: data },
            { role: "user", content: question },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        },
      );

      return { status: 1, text: response.data.choices[0].message };
    } catch (error) {
      console.log(error);
      return { status: 0 };
    }
  },

  /**
   * Start the MCP server, or report the one already running.
   *
   * The previous version called `runMcpServer()` and returned `{status: 1}`
   * without waiting for it, so a second press threw an unhandled `EADDRINUSE`
   * while the UI cheerfully reported success.
   */
  runMcpServer: async () => {
    const result = await startMcpServer();
    return {
      status: result.ok ? 1 : 0,
      url: result.url,
      token: result.token,
      command: mcpAddCommand(),
      alreadyRunning: result.alreadyRunning,
      error: result.error,
    };
  },

  mcpStatus: async () => ({
    status: 1,
    running: isMcpRunning(),
    url: mcpUrl(),
    token: mcpToken(),
    command: mcpAddCommand(),
  }),

  setKey: async (evt, key) => {
    store.set("ai_openai_key", key);
    return { status: 1 };
  },

  getKey: async (evt, key) => {
    const value = store.get("ai_openai_key");
    if (value == undefined) {
      return { status: 0 };
    }
    return { status: 1, value: value };
  },
};
