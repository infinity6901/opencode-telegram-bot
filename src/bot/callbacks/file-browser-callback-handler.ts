import { promises as fs } from "node:fs";
import { InlineKeyboard, type Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import {
  getProjectRoot,
  isPathWithinDirectory,
  isWithinAllowedRoot,
  isWithinProjectRoot,
  joinPath,
  pathToDisplayPath,
} from "../../app/services/file-browser-service.js";
import { removeHiddenProjectPath } from "../../app/stores/settings-store.js";
import type { InteractionState } from "../../app/types/interaction.js";
import {
  isForegroundBusy,
  type ForegroundBusyDeps,
} from "../../app/services/run-control-service.js";
import { t } from "../../i18n/index.js";
import { alert, failure } from "./feedback.js";
import { getProjectByWorktree } from "../../app/services/project-service.js";
import { upsertSessionDirectory } from "../../app/services/session-cache-service.js";
import { logger } from "../../utils/logger.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import {
  ensureActiveInlineMenu,
  clearActiveInlineMenu,
  type InlineMenuDeps,
} from "../menus/inline-menu.js";
import { sendDownloadedFile } from "../messages/send-downloaded-file.js";
import {
  switchToProject,
  type ProjectSwitchDeps,
} from "../../app/services/project-switch-service.js";
import {
  createProjectSwitchPresentation,
  type ProjectSwitchPresentationDeps,
} from "../services/project-switch-presentation.js";
import { promptAttachment } from "../../app/managers/prompt-attachment-manager.js";
import { toRelativePath } from "../../app/services/prompt-attachment-service.js";
import { ATTACHMENT_CANCEL_CALLBACK } from "./prompt-attachment-callback-handler.js";
import {
  buildOpenRootsKeyboard,
  clearLsPathIndex,
  clearOpenPathIndex,
  decodeLsAttachCallback,
  decodeLsBackCallback,
  decodeLsFileCallback,
  decodeLsPaginationCallback,
  decodeLsPathFromCallback,
  decodeOpenPaginationCallback,
  decodeOpenPathFromCallback,
  LS_CALLBACK_DOWNLOAD_PREFIX,
  LS_CALLBACK_NAV_PREFIX,
  LS_CALLBACK_PREFIX,
  OPEN_CALLBACK_NAV_PREFIX,
  OPEN_CALLBACK_NEW_FOLDER_CANCEL,
  OPEN_CALLBACK_NEW_FOLDER_PREFIX,
  OPEN_CALLBACK_PREFIX,
  OPEN_CALLBACK_ROOTS,
  OPEN_CALLBACK_SELECT_PREFIX,
  renderLsBrowseView,
  renderLsFileDetailsView,
  renderOpenBrowseView,
} from "../menus/file-browser-menu.js";

export type LsCallbackDeps = ForegroundBusyDeps & InlineMenuDeps;

export type OpenCallbackDeps = Pick<AppContainer, "ensureEventSubscription"> &
  ForegroundBusyDeps &
  InlineMenuDeps &
  ProjectSwitchDeps &
  ProjectSwitchPresentationDeps;

const sessionDirectories = new Map<number, string>();

export function clearSessionDirectories(): void {
  sessionDirectories.clear();
}

export function resolveInitialLsDirectory(userId?: number): string | null {
  const currentProject = getProjectRoot();
  if (!currentProject) {
    return null;
  }

  if (userId) {
    const cachedDirectory = sessionDirectories.get(userId);
    if (cachedDirectory && isPathWithinDirectory(cachedDirectory, currentProject)) {
      return cachedDirectory;
    }
  }

  return currentProject;
}

export function rememberLsDirectory(userId: number | undefined, directory: string): void {
  if (userId) {
    sessionDirectories.set(userId, directory);
  }
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function isNewFolderInteraction(state: InteractionState | null): state is InteractionState {
  return state?.kind === "custom" && state.metadata.action === "open_new_folder";
}

export async function handleOpenCallback(
  ctx: Context,
  deps: OpenCallbackDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(OPEN_CALLBACK_PREFIX)) {
    return false;
  }

  if (data === OPEN_CALLBACK_NEW_FOLDER_CANCEL) {
    await cancelNewFolder(ctx, deps);
    return true;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "open", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    if (data === OPEN_CALLBACK_ROOTS) {
      await showOpenRoots(ctx);
      return true;
    }

    const navPath = decodeOpenPathFromCallback(OPEN_CALLBACK_NAV_PREFIX, data);
    if (navPath !== null) {
      if (!isWithinAllowedRoot(navPath)) {
        await alert(ctx, "open.access_denied");
        return true;
      }
      await navigateOpenTo(ctx, navPath);
      return true;
    }

    const pageInfo = decodeOpenPaginationCallback(data);
    if (pageInfo !== null) {
      if (!isWithinAllowedRoot(pageInfo.path)) {
        await alert(ctx, "open.access_denied");
        return true;
      }
      await navigateOpenTo(ctx, pageInfo.path, pageInfo.page);
      return true;
    }

    const selectPath = decodeOpenPathFromCallback(OPEN_CALLBACK_SELECT_PREFIX, data);
    if (selectPath !== null) {
      if (!isWithinAllowedRoot(selectPath)) {
        await alert(ctx, "open.access_denied");
        return true;
      }
      await selectDirectory(ctx, selectPath, deps);
      return true;
    }

    const newFolderPath = decodeOpenPathFromCallback(OPEN_CALLBACK_NEW_FOLDER_PREFIX, data);
    if (newFolderPath !== null) {
      if (!isWithinAllowedRoot(newFolderPath)) {
        await alert(ctx, "open.access_denied");
        return true;
      }
      await promptNewFolder(ctx, newFolderPath, deps);
      return true;
    }

    return false;
  } catch (error) {
    logger.error("[Bot] Error handling open callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
    return true;
  }
}

async function showOpenRoots(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(t("open.select_root"), { reply_markup: buildOpenRootsKeyboard() });
}

async function navigateOpenTo(ctx: Context, dirPath: string, page: number = 0): Promise<void> {
  const view = await renderOpenBrowseView(dirPath, page);

  if ("error" in view) {
    await ctx.answerCallbackQuery({ text: view.error });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
}

async function addAndSelectDirectory(
  ctx: Context,
  directory: string,
  deps: OpenCallbackDeps,
): Promise<{ displayPath: string; replyKeyboard: Awaited<ReturnType<typeof switchToProject>> }> {
  const displayPath = pathToDisplayPath(directory);

  logger.info(`[Bot] Adding project directory: ${directory}`);
  await removeHiddenProjectPath(directory);
  await upsertSessionDirectory(directory, Date.now());

  const projectInfo = await getProjectByWorktree(directory);
  const selectedProjectInfo = { ...projectInfo, name: displayPath };
  const replyKeyboard = await switchToProject(ctx, selectedProjectInfo, "open_project_selected", {
    ...deps,
    presentation: createProjectSwitchPresentation(deps),
  });

  clearOpenPathIndex();
  return { displayPath, replyKeyboard };
}

async function selectDirectory(
  ctx: Context,
  directory: string,
  deps: OpenCallbackDeps,
): Promise<void> {
  try {
    const { displayPath, replyKeyboard } = await addAndSelectDirectory(ctx, directory, deps);

    await ctx.answerCallbackQuery();
    await ctx.reply(t("open.selected", { project: displayPath }), { reply_markup: replyKeyboard });
    await ctx.deleteMessage();

    logger.info(`[Bot] Project added and selected: ${displayPath}`);
  } catch (error) {
    logger.error("[Bot] Error selecting directory:", error);
    await failure(ctx, "open.select_error");
  }
}

async function promptNewFolder(
  ctx: Context,
  directory: string,
  deps: OpenCallbackDeps,
): Promise<void> {
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null) {
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    t("open.new_folder.prompt", { path: pathToDisplayPath(directory) }),
    {
      reply_markup: new InlineKeyboard().text(
        t("inline.button.cancel"),
        OPEN_CALLBACK_NEW_FOLDER_CANCEL,
      ),
    },
  );

  deps.interactionManager.start({
    kind: "custom",
    expectedInput: "text",
    metadata: { menuKind: "open", action: "open_new_folder", directory, messageId },
  });

  logger.debug(`[Bot] Waiting for a new folder name in: ${directory}`);
}

async function cancelNewFolder(ctx: Context, deps: OpenCallbackDeps): Promise<void> {
  const state = deps.interactionManager.getSnapshot();
  if (!isNewFolderInteraction(state)) {
    await alert(ctx, "inline.inactive_callback");
    return;
  }

  const directory = state.metadata.directory;
  const messageId = state.metadata.messageId;

  if (typeof directory !== "string" || typeof messageId !== "number") {
    deps.interactionManager.clear("open_new_folder_cancelled");
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
    return;
  }

  const view = await renderOpenBrowseView(directory);
  if ("error" in view) {
    await ctx.answerCallbackQuery({ text: view.error });
    return;
  }

  deps.interactionManager.clear("open_new_folder_cancelled");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  deps.interactionManager.start({
    kind: "inline",
    expectedInput: "callback",
    metadata: { menuKind: "open", messageId },
  });
}

function isWindowsDirectoryPath(directory: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith("\\\\");
}

function isValidNewFolderName(name: string, directory: string): boolean {
  if (!name || name === "." || name === ".." || name.startsWith(".")) {
    return false;
  }

  if (name.length > 255 || /[\\/\x00-\x1f]/.test(name)) {
    return false;
  }

  if (isWindowsDirectoryPath(directory)) {
    if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
      return false;
    }
  }

  return true;
}

export async function handleOpenNewFolderTextInput(
  ctx: Context,
  deps: OpenCallbackDeps,
): Promise<boolean> {
  const state = deps.interactionManager.getSnapshot();
  if (!isNewFolderInteraction(state)) {
    return false;
  }

  const text = ctx.message?.text;
  if (text === undefined || text.startsWith("/")) {
    return false;
  }

  const directory = state.metadata.directory;
  const menuMessageId = state.metadata.messageId;
  if (typeof directory !== "string" || typeof menuMessageId !== "number") {
    deps.interactionManager.clear("open_new_folder_missing_state");
    await ctx.reply(t("open.open_error"));
    return true;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const name = text.trim();
  if (!isValidNewFolderName(name, directory)) {
    await ctx.reply(t("open.new_folder.invalid"));
    return true;
  }

  const target = joinPath(directory, name);
  if (!isWithinAllowedRoot(target)) {
    await ctx.reply(t("open.access_denied"));
    return true;
  }

  try {
    await fs.mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await ctx.reply(t("open.new_folder.exists"));
      return true;
    }

    logger.error(`[Bot] Error creating folder ${target}:`, error);
    await ctx.reply(t("open.new_folder.error"));
    return true;
  }

  logger.info(`[Bot] New folder created: ${target}`);

  try {
    const { displayPath, replyKeyboard } = await addAndSelectDirectory(ctx, target, deps);
    if (ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, menuMessageId).catch(() => {});
    }
    await ctx.reply(t("open.selected", { project: displayPath }), { reply_markup: replyKeyboard });

    logger.info(`[Bot] Project added and selected: ${displayPath}`);
  } catch (error) {
    logger.error("[Bot] Error adding new folder as a project:", error);
    await ctx.reply(t("open.select_error"));
  }

  return true;
}

export async function handleLsCallback(ctx: Context, deps: LsCallbackDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(LS_CALLBACK_PREFIX)) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "ls", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    const navPath = decodeLsPathFromCallback(LS_CALLBACK_NAV_PREFIX, data);
    if (navPath !== null) {
      if (!isWithinProjectRoot(navPath)) {
        await alert(ctx, "ls.access_denied");
        return true;
      }
      await navigateLsTo(ctx, navPath);
      return true;
    }

    const pageInfo = decodeLsPaginationCallback(data);
    if (pageInfo !== null) {
      if (!isWithinProjectRoot(pageInfo.path)) {
        await alert(ctx, "ls.access_denied");
        return true;
      }
      await navigateLsTo(ctx, pageInfo.path, pageInfo.page);
      return true;
    }

    const fileInfo = decodeLsFileCallback(data);
    if (fileInfo !== null) {
      if (!isWithinProjectRoot(fileInfo.path)) {
        await alert(ctx, "ls.access_denied");
        return true;
      }
      await showLsFileDetails(ctx, fileInfo.path, fileInfo.page);
      return true;
    }

    const attachPath = decodeLsAttachCallback(data);
    if (attachPath !== null) {
      if (!isWithinProjectRoot(attachPath)) {
        await alert(ctx, "ls.access_denied");
        return true;
      }
      await attachFileAndClose(ctx, deps, attachPath);
      return true;
    }

    const downloadPath = decodeLsPathFromCallback(LS_CALLBACK_DOWNLOAD_PREFIX, data);
    if (downloadPath !== null) {
      if (!isWithinProjectRoot(downloadPath)) {
        await alert(ctx, "ls.access_denied");
        return true;
      }
      await downloadFileAndClose(ctx, deps, downloadPath);
      return true;
    }

    const backInfo = decodeLsBackCallback(data);
    if (backInfo !== null) {
      if (!isWithinProjectRoot(backInfo.path)) {
        await alert(ctx, "ls.access_denied");
        return true;
      }
      await navigateLsTo(ctx, backInfo.path, backInfo.page);
      return true;
    }

    return false;
  } catch (error) {
    logger.error("[Ls] Error handling callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
    return true;
  }
}

async function navigateLsTo(ctx: Context, dirPath: string, page: number = 0): Promise<void> {
  const view = await renderLsBrowseView(dirPath, page);
  if ("error" in view) {
    await ctx.answerCallbackQuery({ text: view.error });
    return;
  }

  rememberLsDirectory(ctx.from?.id, dirPath);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
}

async function showLsFileDetails(ctx: Context, filePath: string, page: number): Promise<void> {
  const view = await renderLsFileDetailsView(filePath, page);
  if ("error" in view) {
    await ctx.answerCallbackQuery({ text: view.error });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
}

async function attachFileAndClose(
  ctx: Context,
  deps: LsCallbackDeps,
  filePath: string,
): Promise<void> {
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    await ctx.answerCallbackQuery({ text: t("bot.project_not_selected") });
    return;
  }

  promptAttachment.set(filePath, projectRoot);

  await ctx.answerCallbackQuery();
  clearActiveInlineMenu("ls_attached", deps);
  clearLsPathIndex();
  await ctx.deleteMessage().catch(() => {});

  const relativePath = toRelativePath(filePath, projectRoot);
  const confirmation = await ctx.reply(t("attachment.added", { path: relativePath }), {
    reply_markup: new InlineKeyboard().text(t("attachment.cancel"), ATTACHMENT_CANCEL_CALLBACK),
  });
  promptAttachment.setConfirmationMessageId(confirmation.message_id);

  // Wait for the prompt the file belongs to: "mixed" lets the text and the cancel button
  // through while blocking commands, menus, and non-text messages.
  deps.interactionManager.start({
    kind: "custom",
    expectedInput: "mixed",
    metadata: { flow: "attachment" },
  });

  logger.info(`[PromptAttachment] Attached from /ls: ${filePath}`);
}

async function downloadFileAndClose(
  ctx: Context,
  deps: LsCallbackDeps,
  filePath: string,
): Promise<void> {
  await ctx.answerCallbackQuery({ text: t("commands.download.downloading") });
  const downloaded = await sendDownloadedFile(ctx, filePath, { announce: false });
  if (!downloaded) {
    return;
  }

  clearActiveInlineMenu("ls_downloaded", deps);
  clearLsPathIndex();
  await ctx.deleteMessage().catch(() => {});
}
