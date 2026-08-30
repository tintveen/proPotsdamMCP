import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: unknown;
};

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("Package version is unavailable.");
}

export const PACKAGE_VERSION = packageJson.version;
