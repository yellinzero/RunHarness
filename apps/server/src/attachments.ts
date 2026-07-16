import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { ImageAttachment, ImageMediaType } from "@runharness/shared";

export const MAX_IMAGE_BYTES = 3_932_160;
export const MAX_IMAGES_PER_SESSION = 10;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ManagedImageAttachment extends ImageAttachment {
  filePath: string;
}

export interface PreparedAttachmentClaim {
  claim(sessionId: string): Promise<ManagedImageAttachment[]>;
  release(): void;
}

export class AttachmentError extends Error {
  statusCode = 400;
}

type StoredAttachment = ImageAttachment & { createdAt: string };

export class AttachmentStore {
  private readonly draftsDir: string;
  private readonly sessionsDir: string;
  private readonly reserved = new Set<string>();

  constructor(private readonly root: string) {
    this.draftsDir = path.join(root, "drafts");
    this.sessionsDir = path.join(root, "sessions");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.draftsDir, { recursive: true }),
      mkdir(this.sessionsDir, { recursive: true }),
    ]);
    await this.cleanExpiredDrafts();
  }

  async upload(name: string, base64: string): Promise<ImageAttachment> {
    if (typeof name !== "string" || typeof base64 !== "string")
      throw new AttachmentError("name and base64 image data are required");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0)
      throw new AttachmentError("Image data must be valid base64");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) throw new AttachmentError("Image is empty");
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new AttachmentError(`Image exceeds the ${formatLimit(MAX_IMAGE_BYTES)} limit`);
    const mediaType = detectImageType(bytes);
    if (!mediaType) throw new AttachmentError("Only PNG, JPEG, GIF, and WebP images are supported");

    const id = `image_${randomUUID()}`;
    const metadata: StoredAttachment = {
      id,
      name: sanitizeName(name, mediaType),
      mediaType,
      size: bytes.length,
      createdAt: new Date().toISOString(),
    };
    const temp = path.join(this.draftsDir, `.${id}.tmp`);
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, this.dataPath(this.draftsDir, id));
      await writeFile(this.metaPath(this.draftsDir, id), JSON.stringify(metadata));
    } catch (error) {
      await rm(temp, { force: true });
      await rm(this.dataPath(this.draftsDir, id), { force: true });
      await rm(this.metaPath(this.draftsDir, id), { force: true });
      throw error;
    }
    return publicMetadata(metadata);
  }

  async removeDraft(id: string): Promise<void> {
    assertId(id);
    const metadata = this.metaPath(this.draftsDir, id);
    try {
      await stat(metadata);
    } catch {
      throw new AttachmentError("Attachment was not found or is already submitted");
    }
    await Promise.all([
      rm(metadata, { force: true }),
      rm(this.dataPath(this.draftsDir, id), { force: true }),
    ]);
  }

  async prepareClaim(ids: string[]): Promise<PreparedAttachmentClaim> {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw new AttachmentError("Attachment IDs must be unique");
    if (unique.length > MAX_IMAGES_PER_SESSION)
      throw new AttachmentError(`A session accepts at most ${MAX_IMAGES_PER_SESSION} images`);
    if (!unique.length) return { claim: async () => [], release: () => undefined };
    unique.forEach(assertId);
    if (unique.some((id) => this.reserved.has(id)))
      throw new AttachmentError("An attachment is already being submitted");
    const entries = await Promise.all(unique.map(async (id) => {
      try {
        const [raw] = await Promise.all([
          readFile(this.metaPath(this.draftsDir, id), "utf8"),
          stat(this.dataPath(this.draftsDir, id)),
        ]);
        const entry = JSON.parse(raw) as StoredAttachment;
        if (entry.id !== id) throw new Error("metadata ID mismatch");
        return entry;
      } catch {
        throw new AttachmentError(`Attachment '${id}' was not found or is already submitted`);
      }
    }));
    unique.forEach((id) => this.reserved.add(id));
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      unique.forEach((id) => this.reserved.delete(id));
    };
    return {
      release,
      claim: async (sessionId) => {
        if (!active) throw new AttachmentError("Attachment claim is no longer active");
        try { return await this.commitClaim(entries, sessionId); }
        finally { release(); }
      },
    };
  }

  async claim(ids: string[], sessionId: string): Promise<ManagedImageAttachment[]> {
    const prepared = await this.prepareClaim(ids);
    return prepared.claim(sessionId);
  }

  async listSession(sessionId: string): Promise<ImageAttachment[]> {
    assertSessionId(sessionId);
    return (await this.readSessionEntries(path.join(this.sessionsDir, sessionId))).map(publicMetadata);
  }

  async selectForRun(sessionId: string, selectedIds: string[] | undefined, draftIds: string[]): Promise<ManagedImageAttachment[]> {
    assertSessionId(sessionId);
    const sessionDir = path.join(this.sessionsDir, sessionId);
    const available = await this.readSessionEntries(sessionDir);
    const selected = selectedIds === undefined ? available.map((entry) => entry.id) : [...new Set(selectedIds)];
    if (selected.length !== (selectedIds?.length ?? selected.length)) throw new AttachmentError("Selected attachment IDs must be unique");
    selected.forEach(assertId);
    const retained = selected.map((id) => available.find((entry) => entry.id === id)).filter((entry): entry is StoredAttachment => Boolean(entry));
    if (retained.length !== selected.length) throw new AttachmentError("A selected attachment does not belong to this Session");
    if (retained.length + draftIds.length > MAX_IMAGES_PER_SESSION)
      throw new AttachmentError(`A Run accepts at most ${MAX_IMAGES_PER_SESSION} images`);
    const added = await this.claim(draftIds, sessionId);
    return [
      ...retained.map((entry) => ({ ...publicMetadata(entry), filePath: this.dataPath(sessionDir, entry.id) })),
      ...added,
    ];
  }

  async readSessionAttachment(sessionId: string, attachmentId: string): Promise<{ attachment: ImageAttachment; bytes: Buffer }> {
    assertSessionId(sessionId); assertId(attachmentId);
    const directory = path.join(this.sessionsDir, sessionId);
    try {
      const metadata = JSON.parse(await readFile(this.metaPath(directory, attachmentId), "utf8")) as StoredAttachment;
      if (metadata.id !== attachmentId) throw new Error("metadata ID mismatch");
      return { attachment: publicMetadata(metadata), bytes: await readFile(this.dataPath(directory, attachmentId)) };
    } catch { throw new AttachmentError("Session attachment was not found"); }
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await rm(path.join(this.sessionsDir, sessionId), { recursive: true, force: true });
  }

  private async commitClaim(entries: StoredAttachment[], sessionId: string): Promise<ManagedImageAttachment[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new AttachmentError("Invalid session ID");
    const sessionDir = path.join(this.sessionsDir, sessionId);
    const stagingDir = path.join(this.sessionsDir, `.${sessionId}-${randomUUID()}.tmp`);
    await mkdir(stagingDir, { recursive: false });
    const moved: Array<{ original: string; current: string }> = [];
    try {
      for (const entry of entries) {
        for (const source of [this.dataPath(this.draftsDir, entry.id), this.metaPath(this.draftsDir, entry.id)]) {
          const destination = path.join(stagingDir, path.basename(source));
          await rename(source, destination);
          moved.push({ original: source, current: destination });
        }
      }
      await mkdir(sessionDir, { recursive: true });
      for (const entry of entries) {
        for (const staged of [this.dataPath(stagingDir, entry.id), this.metaPath(stagingDir, entry.id)]) {
          const destination = path.join(sessionDir, path.basename(staged));
          await rename(staged, destination);
          const move = moved.find((item) => item.current === staged);
          if (move) move.current = destination;
        }
      }
      await rm(stagingDir, { recursive: true, force: true });
      return entries.map((entry) => ({
        ...publicMetadata(entry),
        filePath: this.dataPath(sessionDir, entry.id),
      }));
    } catch (error) {
      for (const move of moved.reverse()) {
        try { await rename(move.current, move.original); } catch { /* 保留最初的附件接管错误。 */ }
      }
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async cleanExpiredDrafts(): Promise<void> {
    const names = await readdir(this.draftsDir);
    const now = Date.now();
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const id = name.slice(0, -5);
      try {
        const metadata = JSON.parse(await readFile(path.join(this.draftsDir, name), "utf8")) as StoredAttachment;
        if (now - Date.parse(metadata.createdAt) <= DRAFT_MAX_AGE_MS) return;
      } catch { /* 无法解析的草稿直接清理。 */ }
      await Promise.all([
        rm(this.metaPath(this.draftsDir, id), { force: true }),
        rm(this.dataPath(this.draftsDir, id), { force: true }),
      ]);
    }));
  }

  private async readSessionEntries(directory: string): Promise<StoredAttachment[]> {
    try {
      const names = await readdir(directory);
      return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as StoredAttachment));
    } catch { return []; }
  }

  private dataPath(directory: string, id: string): string { return path.join(directory, `${id}.image`); }
  private metaPath(directory: string, id: string): string { return path.join(directory, `${id}.json`); }
}

function assertId(id: string): void {
  if (!/^image_[0-9a-f-]{36}$/.test(id)) throw new AttachmentError("Invalid attachment ID");
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AttachmentError("Invalid session ID");
}

function detectImageType(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const prefix = bytes.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function sanitizeName(input: string, mediaType: ImageMediaType): string {
  const clean = stripTerminalControls(path.basename(input)).trim().slice(0, 120);
  return clean || `image.${mediaType.split("/")[1]}`;
}

function stripTerminalControls(value: string): string {
  let clean = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      if (value[index + 1] === "[") {
        index += 2;
        while (index < value.length && !/[A-Za-z]/.test(value[index]!)) index += 1;
      }
      continue;
    }
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    clean += value[index];
  }
  return clean;
}

function publicMetadata(value: StoredAttachment): ImageAttachment {
  return { id: value.id, name: value.name, mediaType: value.mediaType, size: value.size };
}

function formatLimit(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
