import type { SessionCapture, SessionDetail } from "@tideline/contracts";
import styles from "../sessions.module.css";

type FileChange = SessionCapture["files"][number];
type ToolDetails = SessionCapture["tools"][number];
type Source = SessionDetail["source"];

const fileLabels: Record<FileChange["change"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

const setupFields = [
  ["clientVersion", "Client version"],
  ["entrypoint", "Entrypoint"],
  ["branch", "Branch"],
  ["provider", "Model provider"],
  ["model", "Reported model"],
  ["reasoningEffort", "Reasoning effort"],
  ["approvalPolicy", "Approval policy"],
  ["sandboxMode", "Sandbox mode"],
  ["permissionMode", "Permission mode"],
] as const satisfies readonly (readonly [keyof SessionCapture["setup"], string])[];

function CaptureUnavailable({ source }: { source: Source }) {
  return (
    <p className={styles.captureNote}>
      {source === "codex" || source === "claude-code" ? (
        <>To capture these details on sync, run <code>tideline sync setup --session-details</code>.</>
      ) : "Detailed capture is available for Codex and Claude Code sessions."}
    </p>
  );
}

function DiffText({ diff, path }: { diff: string; path: string }) {
  const lines = diff.split("\n");
  let insideHunk = false;

  return (
    <pre className={styles.captureCode} aria-label={`Unified diff for ${path}`} tabIndex={0}>
      <code>{lines.map((line, index) => {
        if (line.startsWith("diff --git ")) insideHunk = false;
        if (line.startsWith("@@")) {
          insideHunk = true;
          return <span key={index} data-diff="header">{line}{index + 1 < lines.length && "\n"}</span>;
        }
        const isFileHeader = !insideHunk && (line.startsWith("--- ") || line.startsWith("+++ "));
        const kind = isFileHeader ? undefined : line.startsWith("+") ? "added"
          : line.startsWith("-") ? "removed" : undefined;
        return <span key={index} data-diff={kind}>{line}{index + 1 < lines.length && "\n"}</span>;
      })}</code>
    </pre>
  );
}

export function SessionFiles({ capture, source }: { capture: SessionCapture | null; source: Source }) {
  const files = new Map<string, FileChange[]>();
  for (const change of capture?.files ?? []) {
    const group = files.get(change.path);
    if (group) group.push(change);
    else files.set(change.path, [change]);
  }

  return (
    <section className={styles.captureSection} aria-label="File changes">
      {!capture ? (
        <>
          <h2>File details unavailable</h2>
          <CaptureUnavailable source={source} />
        </>
      ) : (
        <>
          <h2>{files.size === 0 ? "No recorded file changes" : "File changes"}</h2>
          {capture.truncated && <p className={styles.captureNote}>Some session details were omitted or reached a capture limit.</p>}
          {files.size > 0 && (
            <ul className={styles.captureList}>
              {[...files].map(([path, changes]) => (
                <li key={path}>
                  <details className={styles.event}>
                    <summary className={styles.eventSummary}>
                      <span aria-hidden="true" className={styles.eventChevron}>›</span>
                      <code className={styles.eventName}>{path}</code>
                      <span className={styles.eventStatus}>
                        {changes.length === 1 ? fileLabels[changes[0].change] : `${changes.length} changes`}
                      </span>
                    </summary>
                    {changes.map(({ line, index, change, previousPath, diff, truncated }) => (
                      <div key={`${line}:${index}`} className={styles.captureBody}>
                        <p className={styles.captureNote}>
                          {fileLabels[change]} on log line {line}{previousPath && <> from <code>{previousPath}</code></>}
                        </p>
                        {diff === null ? <p className={styles.captureNote}>Diff unavailable for this change.</p>
                          : <DiffText diff={diff} path={path} />}
                        {truncated && <p className={styles.captureNote}>This diff reached the capture limit.</p>}
                      </div>
                    ))}
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function SessionSetup({ capture, session }: { capture: SessionCapture | null; session: SessionDetail }) {
  const setup = setupFields.flatMap(([key, label]) => {
    const value = capture?.setup[key];
    return value ? [{ label, value }] : [];
  });
  const observed = [
    { label: "Models", values: session.analytics?.models.flatMap(({ model }) => model ? [model] : []) ?? [] },
    { label: "MCP servers", values: session.activity?.tools.flatMap(({ mcpServer, name }) => {
      const [prefix, reportedServer, tool] = name.split("__");
      const server = mcpServer ?? (prefix === "mcp" && tool ? reportedServer : undefined);
      return server ? [server] : [];
    }) ?? [] },
    { label: "Skills", values: session.activity?.skills.map(({ name }) => name) ?? [] },
  ].filter(({ values }) => values.length > 0);

  return (
    <div className={styles.captureList}>
      <section className={styles.captureSection} aria-label="Agent configuration">
        <h2>Agent configuration</h2>
        {setup.length > 0 ? (
          <dl className={styles.setupRows}>
            {setup.map(({ label, value }) => (
              <div className={styles.setupRow} key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>
            ))}
          </dl>
        ) : (
          <>
            <p className={styles.captureNote}>Setup settings unavailable for this session.</p>
            {!capture && <CaptureUnavailable source={session.source} />}
          </>
        )}
      </section>
      {observed.length > 0 && (
        <section className={styles.captureSection} aria-label="Observed during this session">
          <h2>Observed during this session</h2>
          <dl className={styles.setupRows}>
            {observed.map(({ label, values }) => (
              <div className={styles.setupRow} key={label}>
                <dt>{label}</dt>
                <dd><ul>{[...new Set(values)].map((value) => <li key={value}><code>{value}</code></li>)}</ul></dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

export function ToolPayload({ payload }: { payload?: ToolDetails }) {
  if (!payload) {
    return <div className={styles.captureBody}><p className={styles.captureNote}>Tool input and output unavailable.</p></div>;
  }

  return (
    <div className={styles.captureBody}>
      {payload.input !== null && (
        <section aria-label="Tool input">
          <h3>Tool input</h3>
          <pre className={styles.captureCode} tabIndex={0}><code>{payload.input}</code></pre>
        </section>
      )}
      {payload.output !== null && (
        <section aria-label="Tool output">
          <h3>Tool output</h3>
          <pre className={styles.captureCode} tabIndex={0}><code>{payload.output}</code></pre>
        </section>
      )}
      {payload.input === null && payload.output === null && (
        <p className={styles.captureNote}>No recorded text input or output for this tool.</p>
      )}
      {payload.truncated && <p className={styles.captureNote}>Some tool content was omitted or reached the capture limit.</p>}
    </div>
  );
}
