import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

export async function readTranscriptSidecar(directory: string, path: string, limit: number) {
  if (await realpath(directory).catch(() => undefined) !== directory) return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!file) return;
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.nlink !== 1) return;
    const size = Math.min(initial.size, limit);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (!bytesRead) return;
      offset += bytesRead;
    }
    const current = await lstat(path);
    if (!current.isFile() || current.ino !== initial.ino || current.dev !== initial.dev ||
        current.nlink !== 1 || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs ||
        current.ctimeMs !== initial.ctimeMs || await realpath(directory) !== directory || bytes.includes(0)) return;
    const truncated = size < initial.size;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    return { text, truncated, identity: { dev: initial.dev, ino: initial.ino } };
  } catch {
    return;
  } finally {
    await file.close();
  }
}
