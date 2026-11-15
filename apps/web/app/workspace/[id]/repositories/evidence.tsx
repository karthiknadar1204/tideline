import {
  repositoryEvidenceQuery, repositoryFilesResponse, repositoryInstructionsResponse, sessionSourceLabel,
} from "@tideline/contracts";
import type { RepositoryEvidenceQuery, RepositoryFilesResponse } from "@tideline/contracts";
import Link from "next/link";
import { formatCount } from "../../../../lib/usage";
import { fetchWorkspaceResource } from "../../../../lib/workspace";
import { DiffText } from "../sessions/[sessionId]/capture";
import styles from "./evidence.module.css";

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const labels = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" } as const;

function FilePagination({ page, hasNext, pageHref }: {
  page: number; hasNext: boolean; pageHref: (page: number) => string;
}) {
  if (page < 2 && !hasNext) return null;
  return (
    <nav className={styles.pagination} aria-label="File pages">
      {page > 1 && <Link href={pageHref(page - 1)}>Previous</Link>}
      <span>Page {page}</span>
      {hasNext && <Link href={pageHref(page + 1)}>Next</Link>}
    </nav>
  );
}

export async function RepositoryFiles({ workspaceId, repository, filters, href }: {
  workspaceId: string;
  repository: string;
  filters: RepositoryEvidenceQuery;
  href: string;
}) {
  const { file: selectedFile } = filters;
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.source) params.set("source", filters.source);
  if (filters.file) params.set("file", filters.file);
  params.set("page", String(filters.page));
  const resource = `${encodeURIComponent(workspaceId)}/repositories/${repository}/files?${params}`;
  const response = await fetchWorkspaceResource(resource);
  const result = repositoryFilesResponse.safeParse(response?.ok ? await response.json() : undefined).data;
  function pageHref(page: number, file = filters.file) {
    const target = new URL(href, "http://localhost");
    if (file) target.searchParams.set("file", file);
    if (page > 1) target.searchParams.set("filesPage", String(page));
    return target.pathname + target.search;
  }

  return (
    <section className={styles.panel} aria-labelledby="repository-files">
      <header className={styles.heading}>
        <div>
          <h2 id="repository-files">{filters.file ? <code>{filters.file}</code> : "File changes"}</h2>
          <p>{filters.file ? "Changes recorded in this repository’s sessions." : "Files changed in the selected sessions."}</p>
          {result?.partial && <p>Some sessions have incomplete file details.</p>}
        </div>
        {filters.file && <Link href={href}>All files</Link>}
      </header>
      {!result ? <p className={styles.empty} role="status">Could not load file changes.</p>
        : result.rows.length ? result.kind === "history" && selectedFile ? (
          <ul className={styles.history}>
            {result.rows.map((change) => (
              <li key={`${change.session.id}:${change.line}:${change.index}`}>
                <details>
                  <summary>
                    <span>{labels[change.change]} <span className={styles.muted}>· {date.format(new Date(change.session.startedAt))} · log line {change.line}</span></span>
                  </summary>
                  <div>
                    <p>Session <Link href={sessionHref(workspaceId, repository, change.session, filters)}>{change.session.title}</Link></p>
                    {change.previousPath && <p>Previous path <code>{change.previousPath}</code></p>}
                    {change.diff === null ? <p>Diff unavailable.</p> : <DiffText diff={change.diff} path={selectedFile} />}
                    {change.truncated && <p>Some diff content could not be captured.</p>}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : result.kind === "index" ? (
          <ul className={styles.rows}>
            {result.rows.map((file) => (
              <li key={file.path}>
                <Link href={pageHref(1, file.path)}><code>{file.path}</code></Link>
                <span>{labels[file.change]} · {formatCount(file.changes)} {file.changes === 1 ? "change" : "changes"}</span>
                <Link href={sessionHref(workspaceId, repository, file.session, filters)} title={file.session.title}>
                  {sessionSourceLabel[file.session.source]} · {date.format(new Date(file.session.startedAt))}
                </Link>
              </li>
            ))}
          </ul>
        ) : null : (
          <div className={styles.empty}>
            <p>No recorded file changes during this period.</p>
            {!filters.file && <p>Enable file capture with <code>tideline sync setup --session-details</code>.</p>}
          </div>
        )}
      {result && <FilePagination page={filters.page} hasNext={result.hasNext} pageHref={pageHref} />}
    </section>
  );
}

function sessionHref(
  workspaceId: string,
  repository: string,
  session: RepositoryFilesResponse["rows"][number]["session"],
  filters: RepositoryEvidenceQuery,
) {
  const search = new URLSearchParams({ repository, view: "files" });
  if (filters.from) search.set("from", filters.from);
  if (filters.to) search.set("to", filters.to);
  if (filters.source) search.set("source", filters.source);
  return `/workspace/${encodeURIComponent(workspaceId)}/sessions/${session.id}?${search}`;
}

export function readRepositoryFilesParams(
  query: Record<string, string | string[] | undefined>,
  scope: Pick<RepositoryEvidenceQuery, "source" | "from" | "to">,
) {
  return repositoryEvidenceQuery.safeParse({ ...scope, file: query.file, page: query.filesPage }).data ??
    repositoryEvidenceQuery.parse(scope);
}

export async function RepositoryInstructions({ workspaceId, repository }: { workspaceId: string; repository: string }) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/repositories/${repository}/instructions`);
  const result = repositoryInstructionsResponse.safeParse(response?.ok ? await response.json() : undefined).data;
  const revision = result?.snapshot.context?.revision ?? result?.snapshot.revision;
  const groups = [
    { kind: "skill", title: "Skills" }, { kind: "agent", title: "Agent definitions" },
    { kind: "config", title: "Agent and MCP configuration" }, { kind: "resource", title: "Skill resources" },
  ] as const;

  return (
    <section className={styles.panel} aria-labelledby="repository-instructions">
      <header className={styles.heading}>
        <div>
          <h2 id="repository-instructions">Repository context</h2>
          {result && (
            <p>Checkout snapshot from <time dateTime={result.observedAt}>{date.format(new Date(result.observedAt))} UTC</time>
              {revision && <> · HEAD <code title={revision}>{revision.slice(0, 8)}</code></>}
            </p>
          )}
          {(result?.snapshot.partial || result?.snapshot.context?.partial) && <p>Some files were unavailable or exceeded capture limits.</p>}
        </div>
      </header>
      {result === undefined ? <p className={styles.empty} role="status">Could not load repository context.</p>
        : result === null ? (
          <div className={styles.empty}>
            <p>No repository context has synced.</p>
            <p>Use <code>tideline sync setup --repository-instructions</code> for instructions or <code>--repository-context</code> for skills, agents, and setup files.</p>
          </div>
        ) : (
          <>
            {result.snapshot.documents.length > 0 && (
              <section aria-label="Agent instructions" className={styles.contextGroup}>
                <h3>Agent instructions</h3>
                <ul className={styles.history}>
                  {result.snapshot.documents.map(({ path, content }, index) => (
                    <li key={path}>
                      <details open={index === 0}>
                        <summary><code>{path}</code></summary>
                        <pre tabIndex={0} aria-label={path}>{content || "Empty instruction file."}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {groups.map(({ kind, title }) => {
              const entries = result.snapshot.context?.entries.filter((entry) => entry.kind === kind) ?? [];
              if (!entries.length) return null;
              return (
                <section key={kind} aria-label={title} className={styles.contextGroup}>
                  <h3>{title}</h3>
                  <ul className={styles.history}>
                    {entries.map((entry) => (
                      <li key={entry.path}>
                        <details>
                          <summary><code>{entry.path}</code></summary>
                          {"content" in entry ? <pre tabIndex={0} aria-label={entry.path}>{entry.content || "Empty definition file."}</pre> : (
                            <dl className={styles.contextMetadata}>
                              <div><dt>File size</dt><dd>{entry.bytes.toLocaleString("en-US")} bytes</dd></div>
                              <div><dt>Collector fingerprint</dt><dd><code>{entry.fingerprint}</code></dd></div>
                              {entry.kind === "resource" && <div><dt>Skill definition</dt><dd><code>{entry.definitionPath}</code></dd></div>}
                            </dl>
                          )}
                        </details>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {!result.snapshot.documents.length && !result.snapshot.context?.entries.length && (
              <p className={styles.empty}>No supported files were found in this snapshot.</p>
            )}
          </>
        )}
    </section>
  );
}
