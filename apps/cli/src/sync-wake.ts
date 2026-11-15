import { constants, watch } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const wakeFile = "collector.wake";

export async function wakeSyncCollector(directory: string) {
  const handle = await open(join(directory, wakeFile),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) return;
    await handle.write("1", 0, "utf8");
  } finally {
    await handle.close();
  }
}

export function watchCollectorWake(directory: string) {
  let pending = false;
  let wake: (() => void) | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (filename !== wakeFile) return;
      if (wake) wake();
      else pending = true;
    });
    watcher.on("error", () => watcher?.close());
  } catch { /* Polling remains available. */ }

  return {
    async wait(signal: AbortSignal, fallbackMs = 2_000) {
      if (pending || signal.aborted) {
        pending = false;
        return;
      }
      await new Promise<void>((resolve) => {
        function finish() {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          wake = undefined;
          resolve();
        }
        const timer = setTimeout(finish, fallbackMs);
        wake = finish;
        signal.addEventListener("abort", finish, { once: true });
      });
    },
    close() {
      watcher?.close();
      wake?.();
    },
  };
}
