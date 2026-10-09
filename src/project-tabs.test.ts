import { describe, expect, it } from "vitest";
import {
  adoptProjectWorkspace,
  closeProjectSession,
  cycleProjectSession,
  initialProjectSessions,
  openProjectSession,
  selectProjectSession,
} from "./project-tabs";
import type { Workspace } from "./types";

function workspace(id: string, path = `/${id}`): Workspace {
  return {
    id,
    name: id,
    path,
    repositoryId: id,
    gitDir: `${path}/.git`,
    commonDir: `${path}/.git`,
    trusted: false,
  };
}

describe("project sessions", () => {
  it("adopts a welcome renderer without replacing its state identity", () => {
    const initial = initialProjectSessions();
    const adopted = adoptProjectWorkspace(initial, "initial", workspace("a"));
    expect(adopted.activeKey).toBe("initial");
    expect(adopted.sessions[0]).toEqual({
      key: "initial",
      workspaceId: "a",
      workspace: workspace("a"),
    });
  });

  it("retains existing project renderers when adding and switching projects", () => {
    const a = adoptProjectWorkspace(
      initialProjectSessions(),
      "initial",
      workspace("a"),
    );
    const b = openProjectSession(a, workspace("b"), "second");
    const selected = selectProjectSession(b, "initial");
    expect(selected.activeKey).toBe("initial");
    expect(selected.sessions[0]).toBe(a.sessions[0]);
    expect(selected.sessions[1]).toBe(b.sessions[1]);
  });

  it("deduplicates canonical workspace identities reached through other paths", () => {
    const initial = adoptProjectWorkspace(
      initialProjectSessions(),
      "initial",
      workspace("a"),
    );
    const next = openProjectSession(initial, workspace("a", "/alias"), "alias");
    expect(next.sessions).toHaveLength(1);
    expect(next.activeKey).toBe("initial");
    expect(next.sessions[0].workspace?.path).toBe("/alias");
  });

  it("closes only the chosen renderer and selects its right-hand neighbor", () => {
    const a = openProjectSession(initialProjectSessions(), workspace("a"), "a");
    const b = openProjectSession(a, workspace("b"), "b");
    const c = openProjectSession(b, workspace("c"), "c");
    const next = closeProjectSession(
      selectProjectSession(c, "b"),
      "b",
      "empty",
    );
    expect(next.activeKey).toBe("c");
    expect(next.sessions.map((session) => session.key)).toEqual(["a", "c"]);
    expect(next.sessions[0]).toBe(a.sessions[0]);
    expect(next.sessions[1]).toBe(c.sessions[2]);
    expect(closeProjectSession(c, "a", "empty").activeKey).toBe("c");
  });

  it("returns to a fresh welcome renderer after closing the last project", () => {
    const state = openProjectSession(
      initialProjectSessions(),
      workspace("a"),
      "a",
    );
    expect(closeProjectSession(state, "a", "empty")).toEqual({
      sessions: [{ key: "empty" }],
      activeKey: "empty",
    });
  });

  it("cycles in both directions without including a welcome renderer", () => {
    const a = openProjectSession(initialProjectSessions(), workspace("a"), "a");
    const b = openProjectSession(a, workspace("b"), "b");
    const c = openProjectSession(b, workspace("c"), "c");
    expect(cycleProjectSession(c, 1).activeKey).toBe("a");
    expect(cycleProjectSession(c, -1).activeKey).toBe("b");
    expect(cycleProjectSession(a, 1)).toBe(a);
  });
});
