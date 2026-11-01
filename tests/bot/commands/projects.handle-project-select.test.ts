import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { t } from "../../../src/i18n/index.js";
import { handleProjectSelect } from "../../../src/bot/callbacks/project-callback-handler.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

const mocked = vi.hoisted(() => ({
  getProjectsMock: vi.fn(),
  getListedProjectsMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  addHiddenProjectPathMock: vi.fn(),
  ensureActiveInlineMenuMock: vi.fn(),
  clearAllInteractionStateMock: vi.fn(),
}));

vi.mock("../../../src/app/services/project-service.js", () => ({
  getProjects: mocked.getProjectsMock,
  getListedProjects: mocked.getListedProjectsMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProjectMock,
  addHiddenProjectPath: mocked.addHiddenProjectPathMock,
}));

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  appendInlineMenuCancelButton: vi.fn((keyboard: unknown) => keyboard),
  ensureActiveInlineMenu: mocked.ensureActiveInlineMenuMock,
  replyWithInlineMenu: vi.fn(),
}));

function createCallbackContext(data: string): Context {
  return {
    callbackQuery: { data } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createDeps() {
  return {
    ...container,
    resetInteractions: mocked.clearAllInteractionStateMock,
  };
}

let container: AppContainer;

beforeEach(() => {
  container = createTestAppContainer();
});

describe("bot/commands/projects handleProjectSelect", () => {
  beforeEach(() => {
    mocked.getProjectsMock.mockReset();
    mocked.getListedProjectsMock.mockReset();
    mocked.getCurrentProjectMock.mockReset().mockReturnValue(undefined);
    mocked.addHiddenProjectPathMock.mockReset().mockResolvedValue(undefined);
    mocked.ensureActiveInlineMenuMock.mockReset();
    mocked.clearAllInteractionStateMock.mockReset();
    mocked.ensureActiveInlineMenuMock.mockResolvedValue(true);
  });

  it("uses callback feedback and does not send chat reply on projects:page:* load error", async () => {
    const ctx = createCallbackContext("projects:page:1");
    const pageLoadError = new Error("failed to load page");
    mocked.getProjectsMock.mockRejectedValue(pageLoadError);

    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("projects.page_load_error"),
    });
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(mocked.clearAllInteractionStateMock).not.toHaveBeenCalled();
  });

  it("keeps project:* selection error behavior with state cleanup and chat error reply", async () => {
    const ctx = createCallbackContext("project:abc");
    mocked.getProjectsMock.mockResolvedValue([
      {
        id: "different-id",
        name: "Other project",
        worktree: "/tmp/other",
      },
    ]);

    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.clearAllInteractionStateMock).toHaveBeenCalledWith("project_select_error");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: t("projects.select_error") });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("shows remove confirmation for a non-current project", async () => {
    mocked.getProjectsMock.mockResolvedValue([
      { id: "p1", name: "Project 1", worktree: "/tmp/p1" },
    ]);
    const ctx = createCallbackContext("projects:remove:p1");

    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      t("projects.remove_confirm", { project: "Project 1" }),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    const [, options] = (ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } },
    ];
    expect(options.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe(
      "projects:remove-confirm:p1",
    );
    expect(options.reply_markup.inline_keyboard[1]?.[0]?.callback_data).toBe(
      "projects:remove-cancel",
    );
  });

  it("blocks removal of the active project", async () => {
    mocked.getProjectsMock.mockResolvedValue([
      { id: "p1", name: "Project 1", worktree: "/tmp/p1" },
    ]);
    mocked.getCurrentProjectMock.mockReturnValue({
      id: "p1",
      name: "Project 1",
      worktree: "/tmp/p1",
    });
    const ctx = createCallbackContext("projects:remove:p1");

    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("projects.remove_current"),
      show_alert: true,
    });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("hides the project after confirmation and rerenders the list", async () => {
    mocked.getProjectsMock.mockResolvedValue([
      { id: "p1", name: "Project 1", worktree: "/tmp/p1" },
    ]);
    mocked.getListedProjectsMock.mockResolvedValue([]);
    const ctx = createCallbackContext("projects:remove-confirm:p1");

    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.addHiddenProjectPathMock).toHaveBeenCalledWith("/tmp/p1");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("projects.removed", { project: "Project 1" }),
    });
    expect(ctx.editMessageText).toHaveBeenCalledWith(t("projects.empty"));
  });

  it("cancels removal and rerenders the project list", async () => {
    mocked.getListedProjectsMock.mockResolvedValue([
      { id: "p1", name: "Project 1", worktree: "/tmp/p1" },
    ]);
    const ctx = createCallbackContext("projects:remove-cancel");

    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.addHiddenProjectPathMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it("blocks project selection callback while foreground session is busy", async () => {
    container.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const ctx = createCallbackContext("project:abc");
    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.getProjectsMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("bot.session_busy"),
    });
  });

  it("does not block permission callbacks while foreground session is busy", async () => {
    container.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const ctx = createCallbackContext("permission:once");
    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(false);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(mocked.getProjectsMock).not.toHaveBeenCalled();
  });

  it("does not block question callbacks while foreground session is busy", async () => {
    container.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const ctx = createCallbackContext("question:select:0:1");
    const handled = await handleProjectSelect(ctx, createDeps());

    expect(handled).toBe(false);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(mocked.getProjectsMock).not.toHaveBeenCalled();
  });
});
