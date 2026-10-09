import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { FolderOpen, Plus, X } from "@phosphor-icons/react";
import { Button } from "./ui/controls";
import { t } from "../i18n";

export interface ProjectTab {
  id: string;
  name: string;
  path: string;
}

export function ProjectTabs({
  projects,
  activeId,
  onSelect,
  onClose,
  onOpen,
}: {
  projects: readonly ProjectTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
}) {
  const group = useId();
  const strip = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const openButton = useRef<HTMLButtonElement>(null);
  const closed = useRef<{ id: string; neighbor: string | null } | null>(null);

  useLayoutEffect(() => {
    const focusActive = () => {
      if (strip.current?.getClientRects().length) {
        (tabs.current.get(activeId ?? "") ?? openButton.current)?.focus();
      }
    };
    window.addEventListener("proof:focus-project", focusActive);
    return () => window.removeEventListener("proof:focus-project", focusActive);
  }, [activeId]);

  useLayoutEffect(() => {
    const reveal = () => {
      if (!strip.current?.getClientRects().length) return;
      tabs.current.get(activeId ?? "")?.parentElement?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    };
    reveal();
    const element = strip.current;
    if (!element) return;
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeId, projects.length]);

  useLayoutEffect(() => {
    const pending = closed.current;
    if (!pending || projects.some((project) => project.id === pending.id))
      return;
    closed.current = null;
    const target = tabs.current.get(activeId ?? pending.neighbor ?? "");
    (target ?? openButton.current)?.focus();
  }, [projects, activeId]);

  function close(id: string) {
    const index = projects.findIndex((project) => project.id === id);
    const focused = document.activeElement;
    const item = tabs.current.get(id)?.parentElement;
    if (item?.contains(focused)) {
      closed.current = {
        id,
        neighbor: (projects[index + 1] ?? projects[index - 1])?.id ?? null,
      };
    }
    onClose(id);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + projects.length - 1) % projects.length;
        break;
      case "ArrowRight":
        next = (index + 1) % projects.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = projects.length - 1;
        break;
      case "Delete":
        event.preventDefault();
        close(projects[index].id);
        return;
      default:
        return;
    }
    event.preventDefault();
    const project = projects[next];
    onSelect(project.id);
    tabs.current.get(project.id)?.focus();
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("proof:focus-project")),
    );
  }

  return (
    <div className="project-tabs" data-tauri-drag-region>
      <div
        ref={strip}
        role="tablist"
        aria-label={t("Projects")}
        aria-orientation="horizontal"
        className="project-tab-strip"
      >
        {projects.map((project, index) => {
          const active = project.id === activeId;
          return (
            <div
              key={project.id}
              className={`project-tab-item${active ? " active" : ""}`}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  close(project.id);
                }
              }}
            >
              <button
                ref={(element) => {
                  if (element) tabs.current.set(project.id, element);
                  else tabs.current.delete(project.id);
                }}
                type="button"
                role="tab"
                id={`project-tab-${group}-${project.id}`}
                aria-selected={active}
                aria-controls={`project-panel-${project.id}`}
                title={project.path}
                tabIndex={active || (!activeId && index === 0) ? 0 : -1}
                className="project-tab-button"
                onClick={() => onSelect(project.id)}
                onKeyDown={(event) => navigate(event, index)}
              >
                <FolderOpen size={15} aria-hidden="true" />
                <span>{project.name}</span>
              </button>
              <Button
                className="project-tab-close"
                aria-label={t("Close project {name}", { name: project.name })}
                title={t("Close project {name}", { name: project.name })}
                tabIndex={active ? 0 : -1}
                onClick={() => close(project.id)}
              >
                <X size={12} aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        ref={openButton}
        className="project-tab-open"
        aria-label={t("Open project")}
        title={t("Open project")}
        onClick={onOpen}
      >
        <Plus size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
