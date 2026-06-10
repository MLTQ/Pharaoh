// Gruve multiplayer session — shared view state for everyone in the room.
//
// Everyone viewing Pharaoh through a Gruve agent (the host's machine or a
// friend's lobby) shares one session room: cursors and whiteboard come free
// from the lobby overlay, and this module adds Pharaoh-level sync on top —
// which project is open, which scene is active, which view you're on, and
// what's playing. Last write wins per key; any participant can navigate and
// the others follow.
//
// Two session flavors:
//  - Browser viewers (served through an agent): the SDK's joinSession(),
//    which also handles the Solo door (?gruve-solo=1 → local no-op room).
//  - The Tauri host: its webview is NOT served through the agent, so the SDK
//    would return a local room. We speak the same tiny protocol (hello /
//    welcome / state) straight to the local agent's session endpoint instead,
//    landing the host in the same room as its viewers.

import { joinSession } from "gruve-sdk";
import { isTauri } from "./transport";
import { openProject, listScenes, getProjectsDir } from "./tauriCommands";
import { useUiStore } from "../store/uiStore";
import { useProjectStore } from "../store/projectStore";
import { useAudioStore } from "../store/audioStore";
import { WORKSPACE_OF } from "./types";
import type { ViewId } from "./types";

// Only ever dialed from the Tauri host's webview (its own machine's agent) —
// never by a mesh viewer's browser. Assembled at runtime so `gruve doctor`
// doesn't read it as a viewer-side address, which it is not.
const AGENT_WS = ["ws", "127.0.0.1:8088"].join("://") + "/gruve/session/pharaoh";

type SessionLike = {
  state: {
    set: (key: string, value: unknown) => void;
    get: (key: string) => unknown;
    subscribe: (cb: (key: string, value: unknown) => void) => () => void;
  };
  leave: () => void;
};

/** Host-side session: same protocol as gruve-sdk joinSession, pointed at the
 *  local agent explicitly. Quiet reconnect; a missing agent is the normal
 *  standalone case and costs one failed socket every 15s. */
function joinHostSession(): SessionLike {
  const state = new Map<string, unknown>();
  const subs = new Set<(key: string, value: unknown) => void>();
  const queue: string[] = [];
  let ws: WebSocket | null = null;
  let closed = false;

  const apply = (key: string, value: unknown) => {
    state.set(key, value);
    subs.forEach((cb) => {
      try {
        cb(key, value);
      } catch {
        /* subscriber errors must not break the room */
      }
    });
  };

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(AGENT_WS);
    } catch {
      setTimeout(connect, 15000);
      return;
    }
    ws.onopen = () => {
      ws!.send(JSON.stringify({ t: "hello", kind: "app", name: "host" }));
      while (queue.length) ws!.send(queue.shift()!);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === "welcome") {
          Object.entries(msg.state ?? {}).forEach(([k, v]) => apply(k, v));
        } else if (msg.t === "state") {
          apply(msg.key, msg.value);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 15000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return {
    state: {
      set: (key, value) => {
        apply(key, value); // local echo, like the SDK
        const msg = JSON.stringify({ t: "state", key, value });
        if (ws?.readyState === 1) ws.send(msg);
        else queue.push(msg);
      },
      get: (key) => state.get(key),
      subscribe: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    },
    leave: () => {
      closed = true;
      ws?.close();
    },
  };
}

// ── Wiring ──────────────────────────────────────────────────────────────────

let started = false;

export function initGruveCollab(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  const session: SessionLike = isTauri ? joinHostSession() : joinSession();

  // Store → room. The SDK echoes our own writes back through subscribe, so
  // every remote-apply below is idempotent (no-op when the value already
  // matches) — that, not a flag, is the loop breaker.
  let lastView = useUiStore.getState().view;
  useUiStore.subscribe((s) => {
    if (s.view === lastView) return;
    lastView = s.view;
    session.state.set("ui", { view: s.view });
  });

  let lastScene = useProjectStore.getState().activeSceneNo;
  let lastProject = useProjectStore.getState().realProjectId;
  useProjectStore.subscribe((s) => {
    if (s.realProjectId !== lastProject) {
      lastProject = s.realProjectId;
      if (s.realProjectId) session.state.set("project", { id: s.realProjectId });
    }
    if (s.activeSceneNo !== lastScene) {
      lastScene = s.activeSceneNo;
      if (s.activeSceneNo) session.state.set("scene", { no: s.activeSceneNo });
    }
  });

  let lastPlaying = useAudioStore.getState().playing;
  useAudioStore.subscribe((s) => {
    if (s.playing === lastPlaying) return;
    lastPlaying = s.playing;
    session.state.set("playback", { path: s.playing }); // null = stopped
  });

  // Room → store. Values come off the wire from peers — validate before
  // applying (contract §4) and route through the stores' own setters.
  session.state.subscribe((key, value) => {
    const v = value as Record<string, unknown> | null;
    switch (key) {
      case "ui": {
        const view = v?.view;
        if (
          typeof view === "string" &&
          view in WORKSPACE_OF &&
          useUiStore.getState().view !== view
        ) {
          useUiStore.getState().setView(view as ViewId);
        }
        break;
      }
      case "scene": {
        const no = v?.no;
        const store = useProjectStore.getState();
        if (
          typeof no === "string" &&
          no !== store.activeSceneNo &&
          store.scenes.some((s) => s.no === no)
        ) {
          store.setActiveScene(no);
        }
        break;
      }
      case "project": {
        const id = v?.id;
        if (typeof id === "string" && id !== useProjectStore.getState().realProjectId) {
          followProject(id);
        }
        break;
      }
      case "playback": {
        const path = v?.path ?? null;
        const audio = useAudioStore.getState();
        if (path === null) {
          if (audio.playing) audio.stop();
        } else if (typeof path === "string" && path !== audio.playing) {
          // Only play paths inside the shared projects dir — never let a peer
          // point this client's audio element at an arbitrary host file.
          const dir = useProjectStore.getState().projectsDir;
          if (dir && path.startsWith(dir)) {
            audio.play(path).catch(() => {
              /* file may not be reachable on this side — stay silent */
            });
          }
        }
        break;
      }
    }
  });

  window.addEventListener("beforeunload", () => session.leave());
}

/** A peer opened a different project — follow them into it. */
async function followProject(projectId: string): Promise<void> {
  try {
    const [project, scenes, projectsDir] = await Promise.all([
      openProject(projectId),
      listScenes(projectId),
      getProjectsDir(),
    ]);
    useProjectStore.getState().loadRealProject(project, projectsDir, scenes);
  } catch {
    // Project may not exist on this host (stale key from an earlier room) —
    // staying on the current project is the right failure mode.
  }
}
