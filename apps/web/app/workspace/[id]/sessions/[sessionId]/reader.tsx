"use client";

import { useSearchParams } from "next/navigation";
import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import styles from "../sessions.module.css";

const views = [
  { id: "timeline", label: "Timeline" },
  { id: "conversation", label: "Conversation" },
  { id: "usage", label: "Usage" },
  { id: "review", label: "Review" },
] as const;

type View = typeof views[number]["id"];
export type ReaderEntry = { key: string; kind: "message" | "activity"; content: ReactNode };
export type ReaderPrompt = { key: string; preview: string };

export function SessionReader({ entries, prompts, context, usage, review, activityNote }: {
  entries: ReaderEntry[];
  prompts: ReaderPrompt[];
  context: ReactNode;
  usage: ReactNode;
  review: ReactNode;
  activityNote: string | undefined;
}) {
  const requested = useSearchParams().get("view");
  const active = views.find(({ id }) => requested === id)?.id ?? "timeline";
  const tabs = useRef<HTMLDivElement>(null);
  const showsConversation = active === "timeline" || active === "conversation";

  function selectView(view: View) {
    if (view === active) return;
    const url = new URL(window.location.href);
    if (view === "timeline") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    url.hash = "";
    window.history.pushState(null, "", url);
  }

  function moveFocus(event: KeyboardEvent, index: number) {
    const last = views.length - 1;
    const next = event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectView(views[next].id);
    tabs.current?.querySelectorAll("button")[next]?.focus();
  }

  return (
    <div className={styles.readerGrid}>
      <section aria-label="Session reader" className={styles.trace}>
        <div ref={tabs} role="tablist" aria-label="Session view" className={styles.timelineTabs}>
          {views.map(({ id, label }, index) => (
            <button
              type="button"
              role="tab"
              id={`session-tab-${id}`}
              key={id}
              aria-selected={active === id}
              aria-controls={`session-panel-${id}`}
              tabIndex={active === id ? 0 : -1}
              onClick={() => selectView(id)}
              onKeyDown={(event) => moveFocus(event, index)}
            >
              {label}
            </button>
          ))}
        </div>
        {views.map(({ id }) => (
          <div key={id} hidden={id !== active} className={styles.tracePanel} role="tabpanel" id={`session-panel-${id}`} aria-labelledby={`session-tab-${id}`} tabIndex={0}>
            {id === active && (showsConversation ? (
              <>
                {active === "timeline" && activityNote && <p className={styles.traceNote}>{activityNote}</p>}
                <ol aria-label={active === "timeline" ? "Session timeline" : "Conversation"} className={styles.timeline}>
                  {entries.filter(({ kind }) => active === "timeline" || kind === "message").map(({ key, content }) => (
                    <li key={key} id={key}>{content}</li>
                  ))}
                </ol>
              </>
            ) : active === "usage" ? usage : review)}
          </div>
        ))}
      </section>
      <aside aria-label="Session context" className={styles.context}>
        {context}
        {showsConversation && !!prompts.length && (
          <nav className={styles.contextSection} aria-label="Jump to a prompt">
            <h2>Prompts</h2>
            <ol className={styles.outlineList}>
              {prompts.map(({ key, preview }, index) => (
                <li key={key}>
                  <a href={`#${key}`} title={preview}><span>{index + 1}</span><span>{preview}</span></a>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </aside>
    </div>
  );
}
