import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ImageAttachment } from "@runharness/shared";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const MAX_DRAFT_IMAGES = 10;
export const MAX_IMAGE_BYTES = 3_932_160;

export async function resolveImagePaths(input: string, cwd = process.cwd()): Promise<string[]> {
  const value = input.trim();
  if (!value) return [];
  const single = path.resolve(cwd, unescapePath(stripMatchingQuotes(value)));
  if (await isImageFile(single)) return [single];
  const tokens = tokenizePaths(value);
  if (!tokens.length) return [];
  const paths = tokens.map((token) => path.resolve(cwd, token));
  return (await Promise.all(paths.map(isImageFile))).every(Boolean) ? paths : [];
}

export async function uploadImage(baseUrl: string, filePath: string): Promise<ImageAttachment> {
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error("Image path must point to a file");
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error(`Image exceeds the ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(2)} MB limit`);
  return uploadImageData(baseUrl, path.basename(filePath), await readFile(filePath));
}

export async function uploadImageData(baseUrl: string, name: string, bytes: Buffer): Promise<ImageAttachment> {
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error(`Image exceeds the ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(2)} MB limit`);
  const response = await fetch(`${baseUrl}/api/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data: bytes.toString("base64") }),
  });
  const body = await response.json() as { attachment?: ImageAttachment; error?: string };
  if (!response.ok || !body.attachment) throw new Error(body.error ?? `Could not attach image (HTTP ${response.status})`);
  return body.attachment;
}

export function looksLikeImagePathInput(input: string): boolean {
  const tokens = tokenizePaths(input.trim());
  return tokens.length > 0 && tokens.every((token) => IMAGE_EXTENSIONS.has(path.extname(token).toLowerCase()));
}

export async function deleteImage(baseUrl: string, id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`Could not remove image (HTTP ${response.status})`);
}

function tokenizePaths(value: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (character === "\\" && quote !== "'" && next && /[\\\s'"()]/.test(next)) { token += next; index += 1; continue; }
    if ((character === "'" || character === '"')) {
      if (!quote) { quote = character; continue; }
      if (quote === character) { quote = undefined; continue; }
    }
    if (/\s/.test(character) && !quote) {
      if (token) { result.push(token); token = ""; }
      continue;
    }
    token += character;
  }
  if (quote) return [];
  if (token) result.push(token);
  return result;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === '"') && value.at(-1) === first ? value.slice(1, -1) : value;
}

function unescapePath(value: string): string { return value.replace(/\\([\\\s'"()])/g, "$1"); }

async function isImageFile(filePath: string): Promise<boolean> {
  if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}
