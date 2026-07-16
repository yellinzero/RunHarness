import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { looksLikeImagePathInput, MAX_IMAGE_BYTES, resolveImagePaths, uploadImage } from "../terminal/image-input.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("terminal image paths", () => {
  it("recognizes quoted and escaped image paths", async () => {
    const root = path.resolve(".tmp/tests", `image-input-${Date.now()}`); roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "screen one.png"), "png");
    await writeFile(path.join(root, "screen-two.webp"), "webp");
    expect(await resolveImagePaths("'screen one.png'", root)).toEqual([path.join(root, "screen one.png")]);
    expect(await resolveImagePaths("screen\\ one.png screen-two.webp", root)).toEqual([path.join(root, "screen one.png"), path.join(root, "screen-two.webp")]);
  });

  it("does not mistake normal pasted text or non-images for attachments", async () => {
    const root = path.resolve(".tmp/tests", `image-text-${Date.now()}`); roots.push(root);
    await mkdir(root, { recursive: true }); await writeFile(path.join(root, "notes.txt"), "hello");
    expect(await resolveImagePaths("please fix the header", root)).toEqual([]);
    expect(await resolveImagePaths("notes.txt", root)).toEqual([]);
    expect(looksLikeImagePathInput("please fix the header")).toBe(false);
    expect(looksLikeImagePathInput("screen\\ one.png screen-two.webp")).toBe(true);
    expect(looksLikeImagePathInput("C:\\Users\\learner\\screen.png")).toBe(true);
  });

  it("rejects an oversized image before building an upload request", async () => {
    const root = path.resolve(".tmp/tests", `image-large-${Date.now()}`); roots.push(root);
    await mkdir(root, { recursive: true });
    const large = path.join(root, "large.png");
    await writeFile(large, ""); await truncate(large, MAX_IMAGE_BYTES + 1);
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { fetched = true; throw new Error("must not fetch"); }) as typeof fetch;
    try { await expect(uploadImage("http://runtime", large)).rejects.toThrow("limit"); }
    finally { globalThis.fetch = originalFetch; }
    expect(fetched).toBe(false);
  });
});
