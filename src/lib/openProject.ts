// Open a project by id from anywhere (launcher, a toast action, a wizard):
// load it, its scenes and the projects dir into the store, then show the
// Pyramid. Mirrors ProjectLauncherView.handleOpen.
import { getProject, getProjectsDir, listScenes } from "./tauriCommands";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";

export async function openProjectById(projectId: string): Promise<void> {
  const [project, scenes, dir] = await Promise.all([getProject(projectId), listScenes(projectId), getProjectsDir()]);
  useProjectStore.getState().loadRealProject(project, dir, scenes);
  useUiStore.getState().setView("pyramid");
}
