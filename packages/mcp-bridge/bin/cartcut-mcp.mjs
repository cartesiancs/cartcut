#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "../src/main.mjs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

run({ version });
