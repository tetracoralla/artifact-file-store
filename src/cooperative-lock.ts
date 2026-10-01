/** Protocol v1: a populated directory with one unique host/PID/nonce marker.
 * Every cooperating writer takes this guard before its legacy product lock.
 * Recovery removes only a confirmed dead owner's exact marker, never a shared
 * directory recursively. A new populated owner therefore survives old cleanup.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { ArtifactStoreError } from "./index.js";

const hostId = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const pattern = /^owner-([a-f0-9]{16})-([1-9][0-9]*)-([a-f0-9-]{36})$/;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function artifactLockName(target: string): string {
  // Conservative alias serialization: only acquisition is shared, never the
  // artifact's identity or revision. Distinct case names remain distinct files.
  const key = path.basename(target).normalize("NFC").toLowerCase();
  return `.openadam-artifact-${createHash("sha256").update(key).digest("hex").slice(0, 24)}.lock`;
}

function dead(owner: string): boolean {
  const parts = pattern.exec(owner);
  if (!parts || parts[1] !== hostId) return false;
  const pid = Number(parts[2]);
  if (!Number.isSafeInteger(pid) || pid > 2147483647) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function removeEmpty(directory: string): Promise<void> {
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(error.code ?? "")) throw error;
  });
}

async function recover(directory: string, candidateOwner?: string): Promise<void> {
  const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ArtifactStoreError("IO", "artifact lock must be a regular directory");
  // Read at most two entries: malformed directories fail closed, without
  // buffering an unbounded owner record or following a FIFO/symlink.
  const entries: string[] = [];
  const handle = await opendir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return;
  for await (const entry of handle) { entries.push(entry.name); if (entries.length > 1) break; }
  if (entries.length === 0) {
    if (candidateOwner === undefined || dead(candidateOwner)) await removeEmpty(directory);
    return;
  }
  const owner = entries[0]!;
  if (entries.length !== 1 || (candidateOwner !== undefined && owner !== candidateOwner) || !dead(owner)) return;
  await unlink(path.join(directory, owner)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await removeEmpty(directory);
}

/** Serialize cooperative single-artifact writers across products and carriers. */
export async function withArtifactWriteLock<T>(target: string, work: () => Promise<T>, timeoutMs = 5000, onWarning?: (message: string) => void): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("timeoutMs must be finite and non-negative");
  const directory = await realpath(path.dirname(target));
  const name = artifactLockName(target);
  const lock = path.join(directory, name);
  const owner = `owner-${hostId}-${process.pid}-${randomUUID()}`;
  const prefix = `${name}.candidate-`;
  // Stream exact candidates and recover only the identifiable dead holder.
  for await (const entry of await opendir(directory)) {
    if (entry.name.startsWith(prefix)) {
      const candidateOwner = entry.name.slice(prefix.length);
      if (pattern.test(candidateOwner)) await recover(path.join(directory, entry.name), candidateOwner);
    }
  }
  const candidate = path.join(directory, prefix + owner);
  await mkdir(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    await writeFile(path.join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      try { await rename(candidate, lock); acquired = true; break; }
      catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "EPERM", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await recover(lock);
        if (performance.now() >= deadline) throw new ArtifactStoreError("BUSY", "another writer owns the artifact lock");
        await delay(Math.min(20, Math.max(1, deadline - performance.now())));
      }
    }
    return await work();
  } finally {
    // Cleanup is auxiliary. A completed publication must remain a success.
    const ownedDirectory = acquired ? lock : candidate;
    await unlink(path.join(ownedDirectory, owner)).then(() => rmdir(ownedDirectory)).catch(() => { try { onWarning?.("completed; releasing the artifact lock failed"); } catch {} });
    if (!acquired) await removeEmpty(candidate).catch(() => undefined);
  }
}
