import { InlineKeyboard, type Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { getListedProjects, getProjects } from "../../app/services/project-service.js";
import { addHiddenProjectPath, getCurrentProject } from "../../app/stores/settings-store.js";
import {
  isForegroundBusy,
  type ForegroundBusyDeps,
} from "../../app/services/run-control-service.js";
import {
  switchToProject,
  type ProjectSwitchDeps,
} from "../../app/services/project-switch-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { alert, failure, notify } from "./feedback.js";
import {
  appendInlineMenuCancelButton,
  ensureActiveInlineMenu,
  type InlineMenuDeps,
} from "../menus/inline-menu.js";
import {
  buildProjectsMenuView,
  parseProjectPageCallback,
  parseProjectRemoveCallback,
  parseProjectRemoveConfirmCallback,
  PROJECT_REMOVE_CANCEL_CALLBACK,
  PROJECT_REMOVE_CONFIRM_CALLBACK_PREFIX,
} from "../menus/project-selection-menu.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import {
  createProjectSwitchPresentation,
  type ProjectSwitchPresentationDeps,
} from "../services/project-switch-presentation.js";
import type { ProjectInfo } from "../../app/types/project.js";

export type ProjectSelectDeps = Pick<AppContainer, "ensureEventSubscription"> &
  ForegroundBusyDeps &
  InlineMenuDeps &
  ProjectSwitchDeps &
  ProjectSwitchPresentationDeps;

async function renderProjectList(
  ctx: Context,
  deps: ProjectSelectDeps,
  page: number,
): Promise<void> {
  const projects = await getListedProjects();
  if (projects.length === 0) {
    deps.interactionManager.clear("project_list_empty");
    await ctx.editMessageText(t("projects.empty"));
    return;
  }

  const { text, keyboard } = await buildProjectsMenuView(projects, page);
  await ctx.editMessageText(text, {
    reply_markup: appendInlineMenuCancelButton(keyboard, "project"),
  });
}

async function showProjectRemoveConfirmation(
  ctx: Context,
  project: ProjectInfo,
): Promise<void> {
  const projectName = project.name || project.worktree;
  const keyboard = new InlineKeyboard()
    .text(
      t("projects.remove_confirm_button"),
      `${PROJECT_REMOVE_CONFIRM_CALLBACK_PREFIX}${project.id}`,
    )
    .row()
    .text(t("inline.button.cancel"), PROJECT_REMOVE_CANCEL_CALLBACK);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(t("projects.remove_confirm", { project: projectName }), {
    reply_markup: keyboard,
  });
}

export async function handleProjectSelect(ctx: Context, deps: ProjectSelectDeps): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data) {
    return false;
  }

  const page = parseProjectPageCallback(callbackQuery.data);
  const isProjectSelection = callbackQuery.data.startsWith("project:");
  const removeProjectId = parseProjectRemoveCallback(callbackQuery.data);
  const removeConfirmProjectId = parseProjectRemoveConfirmCallback(callbackQuery.data);
  const isRemoveCancel = callbackQuery.data === PROJECT_REMOVE_CANCEL_CALLBACK;
  const isProjectRemoval =
    removeProjectId !== null || removeConfirmProjectId !== null || isRemoveCancel;

  if (page === null && !isProjectSelection && !isProjectRemoval) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (isProjectRemoval) {
    const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
    if (!isActiveMenu) {
      return true;
    }

    try {
      if (isRemoveCancel) {
        await ctx.answerCallbackQuery();
        await renderProjectList(ctx, deps, 0);
        return true;
      }

      const projectId = removeProjectId ?? removeConfirmProjectId;
      if (!projectId) {
        await alert(ctx, "projects.remove_error");
        return true;
      }

      const projects = await getProjects();
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        throw new Error(`Project with id ${projectId} not found`);
      }

      const currentProject = getCurrentProject();
      const isCurrentProject =
        currentProject !== undefined &&
        (project.id === currentProject.id || project.worktree === currentProject.worktree);

      if (removeProjectId !== null) {
        if (isCurrentProject) {
          await alert(ctx, "projects.remove_current");
          return true;
        }

        await showProjectRemoveConfirmation(ctx, project);
        return true;
      }

      if (isCurrentProject) {
        await alert(ctx, "projects.remove_current");
        return true;
      }

      await addHiddenProjectPath(project.worktree);
      logger.info(`[Bot] Project hidden from list: ${project.worktree}`);
      await notify(ctx, "projects.removed", { project: project.name || project.worktree });
      await renderProjectList(ctx, deps, 0);
    } catch (error) {
      logger.error("[Bot] Error removing project:", error);
      await failure(ctx, "projects.remove_error");
    }

    return true;
  }

  if (page !== null) {
    const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
    if (!isActiveMenu) {
      return true;
    }

    try {
      const projects = await getListedProjects();
      if (projects.length === 0) {
        await alert(ctx, "projects.empty");
        return true;
      }

      const { text, keyboard } = await buildProjectsMenuView(projects, page);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        reply_markup: appendInlineMenuCancelButton(keyboard, "project"),
      });
    } catch (error) {
      logger.error("[Bot] Error switching projects page:", error);
      await ctx.answerCallbackQuery({ text: t("projects.page_load_error") });
    }

    return true;
  }

  const projectId = callbackQuery.data.replace("project:", "");

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    const projects = await getProjects();
    const selectedProject = projects.find((p) => p.id === projectId);

    if (!selectedProject) {
      throw new Error(`Project with id ${projectId} not found`);
    }

    const projectName = selectedProject.name || selectedProject.worktree;

    logger.info(`[Bot] Project selected: ${projectName} (id: ${projectId})`);

    const keyboard = await switchToProject(ctx, selectedProject, "project_switched", {
      ...deps,
      presentation: createProjectSwitchPresentation(deps),
    });

    await ctx.answerCallbackQuery();
    await ctx.reply(t("projects.selected", { project: projectName }), {
      reply_markup: keyboard,
    });

    await ctx.deleteMessage();
  } catch (error) {
    deps.resetInteractions("project_select_error");
    logger.error("[Bot] Error selecting project:", error);
    await failure(ctx, "projects.select_error");
  }

  return true;
}
