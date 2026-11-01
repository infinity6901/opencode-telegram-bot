import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const UPLOAD_DIRECTORY = path.join(".opencode-telegram", "uploads");

export interface SavedUpload {
  absolutePath: string;
  relativePath: string;
}

export function sanitizeUploadFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || "file";
  const sanitized = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return sanitized || "file";
}

export async function saveUploadedFileToProject(
  worktree: string,
  filename: string,
  buffer: Buffer,
): Promise<SavedUpload> {
  const root = path.resolve(worktree);
  const uploadDirectory = path.join(root, UPLOAD_DIRECTORY);
  await fs.mkdir(uploadDirectory, { recursive: true });

  const uniqueName = `${Date.now()}-${randomUUID().slice(0, 8)}-${sanitizeUploadFilename(filename)}`;
  const absolutePath = path.join(uploadDirectory, uniqueName);
  const relativePath = path.relative(root, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Upload path escapes project root");
  }

  await fs.writeFile(absolutePath, buffer);

  return {
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}
