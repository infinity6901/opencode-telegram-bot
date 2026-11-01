import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  saveUploadedFileToProject,
  sanitizeUploadFilename,
  UPLOAD_DIRECTORY,
} from "../../../src/app/services/upload-storage-service.js";

describe("app/services/upload-storage-service", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-upload-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("sanitizes path separators and unsafe characters", () => {
    expect(sanitizeUploadFilename("../../Android Project.zip")).toBe("Android_Project.zip");
    expect(sanitizeUploadFilename("a/b\\c:d?.zip")).toBe("c_d_.zip");
    expect(sanitizeUploadFilename("")).toBe("file");
  });

  it("saves the file under the project upload directory", async () => {
    const saved = await saveUploadedFileToProject(
      worktree,
      "android-project.zip",
      Buffer.from("zip bytes"),
    );

    expect(saved.relativePath.startsWith(`${UPLOAD_DIRECTORY.split(path.sep).join("/")}/`)).toBe(
      true,
    );
    expect(saved.relativePath.endsWith("-android-project.zip")).toBe(true);
    expect(await readFile(saved.absolutePath, "utf8")).toBe("zip bytes");
  });

  it("does not overwrite files with the same name", async () => {
    const first = await saveUploadedFileToProject(worktree, "project.zip", Buffer.from("first"));
    const second = await saveUploadedFileToProject(worktree, "project.zip", Buffer.from("second"));

    expect(first.absolutePath).not.toBe(second.absolutePath);
    expect(await readFile(first.absolutePath, "utf8")).toBe("first");
    expect(await readFile(second.absolutePath, "utf8")).toBe("second");
  });
});
