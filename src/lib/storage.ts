import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function rootDir() {
  return path.resolve(process.env.STORAGE_DIR ?? "./data/uploads");
}

export function maxUploadBytes() {
  const value = Number(process.env.MAX_UPLOAD_BYTES ?? "10485760");
  return Number.isFinite(value) && value > 0 ? value : 10_485_760;
}

function validateStorageKey(storageKey: string) {
  if (!/^[0-9a-f-]{36}$/i.test(storageKey)) {
    throw new Error("Invalid storage key.");
  }
}

export async function storeFile(file: File) {
  if (file.size <= 0) throw new Error("The uploaded file is empty.");
  if (file.size > maxUploadBytes()) throw new Error("The uploaded file is too large.");

  const bytes = Buffer.from(await file.arrayBuffer());
  const key = randomUUID();
  const root = rootDir();

  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, key), bytes, { flag: "wx" });

  return {
    storageKey: key,
    originalName: path.basename(file.name || "document"),
    mimeType: file.type || "application/octet-stream",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function loadFile(storageKey: string) {
  validateStorageKey(storageKey);
  return readFile(path.join(rootDir(), storageKey));
}

export async function removeStoredFile(storageKey: string) {
  validateStorageKey(storageKey);
  await unlink(path.join(rootDir(), storageKey));
}
