import { invoke } from "@tauri-apps/api/core";
import type { Project, Scene, ScriptRow } from "./types";

// ── Project ──────────────────────────────────────────────────────────────────

export const getProjectsDir = (): Promise<string> =>
  invoke("get_projects_dir");

export const createProject = (args: {
  title: string;
  logline?: string;
  tone?: string;
}): Promise<Project> => invoke("create_project", args);

export const openProject = (projectId: string): Promise<Project> =>
  invoke("open_project", { projectId });

export const getProject = (projectId: string): Promise<Project> =>
  invoke("get_project", { projectId });

export const listProjects = (): Promise<Project[]> =>
  invoke("list_projects");

export const updateProject = (project: Project): Promise<Project> =>
  invoke("update_project", { project });

// ── Scenes ───────────────────────────────────────────────────────────────────

export const createScene = (args: {
  projectId: string;
  title: string;
  description?: string;
  location?: string;
  index: number;
}): Promise<Scene> => invoke("create_scene", args);

export const updateScene = (args: {
  projectId: string;
  scene: Scene;
}): Promise<Scene> => invoke("update_scene", args);

export const getScene = (args: {
  projectId: string;
  sceneId: string;
}): Promise<Scene> => invoke("get_scene", args);

export const listScenes = (projectId: string): Promise<Scene[]> =>
  invoke("list_scenes", { projectId });

// ── Script CSV ───────────────────────────────────────────────────────────────

export const readScript = (args: {
  projectId: string;
  sceneSlug: string;
}): Promise<ScriptRow[]> => invoke("read_script", args);

export const writeScript = (args: {
  projectId: string;
  sceneSlug: string;
  rows: ScriptRow[];
}): Promise<void> => invoke("write_script", args);

export const updateScriptRow = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  fields: Partial<Record<string, string>>;
}): Promise<ScriptRow> => invoke("update_script_row", args);
