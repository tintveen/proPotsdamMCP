import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

export async function writeTextFile(filePath: string, text: string): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, text);
}

export function sanitizeFileName(input: string): string {
  return input.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}
