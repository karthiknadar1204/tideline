"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { transcriptPage, transcriptStreams } from "@tideline/contracts/transcripts";
import type { TranscriptRecord } from "@tideline/contracts/transcripts";
import styles from "../sessions.module.css";

export function FullTranscript({ url }: { url: string }) {
  const [streams, setStreams] = useState<string[]>([]);
  const [stream, selectStream] = useState("main");
  const readStreams = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${url}/streams`, { signal, cache: "no-store" });
      if (response.ok) setStreams(transcriptStreams.parse(await response.json()).streams.filter((id) => id !== "main"));
    } catch { /* The main archive can be read independently. */ }
  }, [url]);

  useEffect(() => {
    const request = new AbortController();
    void readStreams(request.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void readStreams(request.signal);
    }, 12_000);
    return () => { request.abort(); window.clearInterval(timer); };
  }, [readStreams]);

  return (
    <section className="space-y-4 p-4 sm:p-6" aria-label="Recorded transcript">
      {streams.length > 0 && (
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          Transcript stream
          <select className="max-w-full rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-2 py-1"
            value={stream} onChange={(event) => selectStream(event.target.value)}>
            <option value="main">Main conversation</option>
            {streams.map((id) => <option key={id} value={id}>Child agent {id.length > 12 ? `${id.slice(0, 12)}…` : id}</option>)}
          </select>
        </label>
      )}
      <TranscriptRecords key={stream} url={url} stream={stream} refreshStreams={readStreams} />
    </section>
  );
}

function TranscriptRecords({ url, stream, refreshStreams }: { url: string; stream: string; refreshStreams: () => Promise<void> }) {
  const [records, setRecords] = useState<TranscriptRecord[]>();
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const streamQuery = new URLSearchParams({ stream }).toString();
  const load = useCallback(async (after: number, signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`${url}?${streamQuery}&after=${after}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Unable to read transcript");
      const page = transcriptPage.parse(await response.json());
      setRecords((previous) => after ? [...previous ?? [], ...page.records] : page.records);
      setNext(page.after);
      setTotal(page.total);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [url, streamQuery]);

  useEffect(() => {
    const request = new AbortController();
    void load(0, request.signal);
    return () => request.abort();
  }, [load]);

  const initialized = records !== undefined;
  useEffect(() => {
    if (!initialized || loading) return;
    const request = new AbortController();
    let timer: number;
    async function update() {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`${url}?${streamQuery}&after=${total}`, { signal: request.signal, cache: "no-store" });
          if (response.ok) {
            const page = transcriptPage.parse(await response.json());
            if (page.total > total && !request.signal.aborted) {
              if (next === null && page.records.length) {
                setRecords((previous) => [...previous ?? [], ...page.records]);
                setNext(page.after);
              }
              setTotal(page.total);
            }
          }
        } catch { /* Resume on the next check. */ }
      }
      if (!request.signal.aborted) timer = window.setTimeout(update, 5_000);
    }
    timer = window.setTimeout(update, 5_000);
    return () => { request.abort(); window.clearTimeout(timer); };
  }, [initialized, loading, next, streamQuery, total, url]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Recorded transcript</h2>
          {total > 0 && <p className={styles.muted}>{total.toLocaleString("en-US")} source records</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {total > 0 && <a className={styles.textLink} href={`${url}/download?${streamQuery}`}>Download JSONL</a>}
          <button className={styles.textLink} type="button" onClick={() => { void load(0); void refreshStreams(); }} disabled={loading}>Refresh transcript</button>
        </div>
      </header>
      {error && <p role="alert">Could not read the transcript. Refresh to try again.</p>}
      {loading && <p role="status" className={styles.muted}>Reading transcript…</p>}
      {records?.length === 0 && <p className={styles.muted}>Enable <code>tideline sync setup --full-transcripts</code> on the computer that recorded this session.</p>}
      {!!records?.length && <ol className="min-w-0 divide-y divide-[var(--workspace-border)]">
        {records.map(({ line, text, attachments, omitted }) => {
          const reference = `${url}/attachments`;
          return (
            <li key={line} className="min-w-0 py-3">
              <details>
                <summary className="cursor-pointer break-words text-sm font-medium">
                  Record {line} {attachments.length > 0 && `· ${attachments.length} image${attachments.length === 1 ? "" : "s"}`}{omitted && " · Some content omitted"}
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-[var(--workspace-subtle)] p-3 text-xs">{text || "Empty line"}</pre>
              </details>
              {attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-3">
                {attachments.map(({ digest, mime }, index) => (
                  <a key={digest} href={`${reference}/${digest}`} download={`record-${line}-image-${index + 1}.${mime.split("/")[1]}`}
                    className="overflow-hidden rounded-lg border border-[var(--workspace-border)]" aria-label={`Download image ${index + 1} from record ${line}`}>
                    <Image src={`${reference}/${digest}`} unoptimized alt={`Recorded image ${index + 1}`}
                      width={160} height={96} className="h-24 w-40 object-contain" />
                  </a>
                ))}
              </div>}
            </li>
          );
        })}
      </ol>}
      {next !== null && <button className={styles.textLink} type="button" onClick={() => void load(next)} disabled={loading}>Load more records</button>}
    </div>
  );
}
