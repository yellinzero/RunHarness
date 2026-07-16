import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore, MAX_IMAGE_BYTES } from "./attachments.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("managed image attachments", () => {
  it("detects bytes, sanitizes names, and claims a draft into a session", async () => {
    const root = path.resolve(".tmp/tests", `attachments-${Date.now()}`); roots.push(root);
    const store = new AttachmentStore(root); await store.initialize();
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("content")]);
    const attachment = await store.upload("../\u001b[31mscreen.png", png.toString("base64"));
    expect(attachment).toMatchObject({ name: "screen.png", mediaType: "image/png", size: png.length });
    const [claimed] = await store.claim([attachment.id], "session_safe");
    expect(await readFile(claimed!.filePath)).toEqual(png);
    expect(claimed!.filePath).toContain(path.join("sessions", "session_safe"));
    expect(await readdir(path.join(root, "drafts"))).toEqual([]);
  });

  it("rejects spoofed, oversized, duplicate, and traversal inputs", async () => {
    const root = path.resolve(".tmp/tests", `attachment-reject-${Date.now()}`); roots.push(root);
    const store = new AttachmentStore(root); await store.initialize();
    await expect(store.upload("fake.png", Buffer.from("not png").toString("base64"))).rejects.toThrow("Only PNG");
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1); oversized.set([137, 80, 78, 71, 13, 10, 26, 10]);
    await expect(store.upload("large.png", oversized.toString("base64"))).rejects.toThrow("limit");
    await expect(store.claim(["../../secret"], "session")).rejects.toThrow("Invalid attachment ID");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await store.upload("ok.png", png.toString("base64"));
    await expect(store.claim([attachment.id, attachment.id], "session")).rejects.toThrow("unique");
  });

  it("preflights every file and rolls the whole claim back on a move failure", async () => {
    const root = path.resolve(".tmp/tests", `attachment-atomic-${Date.now()}`); roots.push(root);
    const store = new AttachmentStore(root); await store.initialize();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const first = await store.upload("first.png", png.toString("base64"));
    const second = await store.upload("second.png", png.toString("base64"));
    const prepared = await store.prepareClaim([first.id, second.id]);
    await rm(path.join(root, "drafts", `${second.id}.image`));
    await expect(prepared.claim("session_atomic")).rejects.toThrow();
    expect(await readFile(path.join(root, "drafts", `${first.id}.image`))).toEqual(png);
    expect(await readdir(path.join(root, "sessions"))).toEqual([]);
  });

  it("selects retained Session images and appends new Run drafts", async () => {
    const root = path.resolve(".tmp/tests", `attachment-next-run-${Date.now()}`); roots.push(root);
    const store = new AttachmentStore(root); await store.initialize();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = await store.upload("context.png", png.toString("base64"));
    await store.claim([attachment.id], "session_parent");
    const added = await store.upload("new.png", png.toString("base64"));

    const selected = await store.selectForRun("session_parent", [attachment.id], [added.id]);

    expect(selected.map((item) => item.name)).toEqual(["context.png", "new.png"]);
    expect(await readFile(selected[0]!.filePath)).toEqual(png);
    expect(await store.listSession("session_parent")).toHaveLength(2);
  });
});
