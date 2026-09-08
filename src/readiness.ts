import { access, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function readinessCheck(options: {
  directory: string;
  scanner: () => Promise<boolean>;
  preview: () => Promise<boolean>;
  minimumFreeBytes?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    (options.minimumFreeBytes !== undefined &&
      (!Number.isFinite(options.minimumFreeBytes) ||
        options.minimumFreeBytes < 0))
  )
    throw new Error("Invalid readiness probe bounds");
  async function probe(check: () => Promise<boolean>) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(check),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let cached: Record<string, boolean> | undefined;
  let expiresAt = 0;
  let pending: Promise<Record<string, boolean>> | undefined;
  async function storage() {
    const path = join(options.directory, `.readiness-${randomUUID()}`);
    try {
      await access(options.directory, constants.W_OK);
      const space = await statfs(options.directory);
      if (
        space.bavail * space.bsize <
        (options.minimumFreeBytes ?? 256 * 1024 * 1024)
      )
        return false;
      const value = randomUUID();
      await writeFile(path, value, { flag: "wx", mode: 0o600 });
      return (await readFile(path, "utf8")) === value;
    } catch {
      return false;
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }
  return async () => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      const results = await Promise.allSettled([
        probe(storage),
        probe(options.scanner),
        probe(options.preview),
      ]);
      const passed = (index: number) =>
        results[index].status === "fulfilled" && results[index].value === true;
      cached = { storage: passed(0), scanner: passed(1), preview: passed(2) };
      expiresAt = Date.now() + 5000;
      return cached;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
