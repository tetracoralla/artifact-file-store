/**
 * Safe single-file artifact storage: revision identity, atomic publication,
 * and cooperative cross-process locks.
 *
 * This package owns the mechanical guarantees shared by local tools that keep
 * a whole artifact (a Markdown document, project metadata, an HTML file) in
 * one file:
 *
 * - revisions derived from the exact bytes, so two byte-distinct files never
 *   share a revision even when decoding would normalize them;
 * - publication as create-exclusive or explicit replace: same-directory
 *   temporary, fsync, rename, mode preservation, and a directory sync; a
 *   failure after the rename is reported as committed with a warning, never
 *   as "nothing was written";
 * - cooperative lock files: exclusive create, an owner record, stale-owner
 *   validation that never steals a live lock, and removal that re-checks the
 *   exact observed file so two processes cannot delete a newer owner's lock.
 *
 * Products keep their own policies: lock naming (which must stay compatible
 * with their other carriers), owner-record format, stale rules, error codes
 * and messages, multi-file transactions, journals, and recovery. The library
 * accepts bytes and explicit policy; it never parses or rewrites content.
 *
 * Cooperative guarantees only: an uncooperative external editor does not take
 * the lock, and the filesystem's rename is not a general compare-and-swap.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { win32 as win32Path } from "node:path";
import { withArtifactWriteLock } from "./cooperative-lock.js";
export { withArtifactWriteLock, artifactLockName } from "./cooperative-lock.js";

/** Why a storage operation failed; consumers translate to their own codes. */
export type ArtifactStoreCause =
  | "EXISTS"
  | "BUSY"
  | "NOT_FOUND"
  | "IO";

export class ArtifactStoreError extends Error {
  readonly causeKind: ArtifactStoreCause;

  constructor(causeKind: ArtifactStoreCause, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.causeKind = causeKind;
  }
}

export interface RevisionPolicy {
  /** Prefix such as `sha256:`; the default is the bare hex digest. */
  prefix?: string;
}

/** Revision identity of the exact bytes; decoding can never normalize it. */
export function revisionFromBytes(bytes: Uint8Array, policy: RevisionPolicy = {}): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${policy.prefix ?? ""}${digest}`;
}

/** Revision identity of a string's exact UTF-8 bytes. */
export function revisionFromText(text: string, policy: RevisionPolicy = {}): string {
  return revisionFromBytes(Buffer.from(text, "utf8"), policy);
}

/**
 * Publish an already-written same-directory temporary over the target.
 *
 * Composable step for products that must re-validate identity between
 * writing the staging bytes and committing them: the caller writes the
 * temporary (for example with `writeArtifactFile` `create`), performs its own
 * checks, then commits here. Failures before the rename leave the original
 * bytes untouched; the rename itself is the commit.
 */
export async function publishTemporaryFile(
  temporary: string,
  target: string,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  try {
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new ArtifactStoreError("IO", "the file could not be published");
  }
  try {
    await fsyncDirectory(path.dirname(target));
  } catch {
    warnings.push("published; syncing the directory failed");
  }
  return { warnings };
}

export interface CreateOptions {
  /** Exclusive creation: an existing target fails with `EXISTS`. */
  kind: "create";
  /** Mode for the new file; the default is 0o600. */
  mode?: number;
}

export interface ReplaceOptions {
  /** Explicit replace authority: temporary + fsync + rename over the target. */
  kind: "replace";
  /** Mode for the published file; the default preserves the target's mode. */
  mode?: number;
  /** Prefix for the same-directory temporary name. */
  temporaryPrefix?: string;
}

export type WriteOptions = CreateOptions | ReplaceOptions;

export interface WriteResult {
  path: string;
  bytes: number;
  revision: string;
  /** Bounded notes about auxiliary actions that failed after committing. */
  warnings: string[];
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publish one artifact file atomically.
 *
 * `create` publishes a fully staged file exclusively and removes its private temporary on
 * failure. `replace` is explicit overwrite authority: it writes a
 * same-directory temporary, fsyncs it, renames it over the target, and syncs
 * the directory. After the rename the write is committed; later auxiliary
 * failures are returned as warnings on a committed result instead of an
 * ordinary error, so callers cannot believe nothing was written.
 */
export async function writeArtifactFile(
  target: string,
  content: string | Uint8Array,
  options: WriteOptions,
): Promise<WriteResult> {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const warnings: string[] = [];
  const directory = path.dirname(target);
  const prefix = options.kind === "replace" ? options.temporaryPrefix ?? `.${path.basename(target)}` : `.${path.basename(target)}`;
  if (path.basename(prefix) !== prefix || prefix === "." || prefix === "..") throw new RangeError("temporaryPrefix must be a file-name prefix");
  const temporary = path.join(directory, `${prefix}.${randomUUID()}.tmp`);
  let mode = options.mode ?? 0o600;
  if (options.kind === "replace") {
    const current = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new ArtifactStoreError("IO", "the target could not be inspected");
    });
    if (current !== undefined) {
      if (!current.isFile() || current.isSymbolicLink()) throw new ArtifactStoreError("IO", "the replace target must be a regular file");
      mode = options.mode ?? (current.mode & 0o777);
    }
  }
  const handle = await open(temporary, "wx", mode).catch(() => {
    throw new ArtifactStoreError("IO", "the staging file could not be created");
  });
  try {
    try {
      await handle.writeFile(data);
      if (options.kind === "replace" || options.mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.kind === "create") await link(temporary, target);
    else await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (options.kind === "create" && isErrno(error, "EEXIST")) throw new ArtifactStoreError("EXISTS", "the destination already exists");
    throw new ArtifactStoreError("IO", "the file could not be published");
  }
  if (options.kind === "create") {
    await unlink(temporary).catch(() => { warnings.push("published; removing the staging file failed"); });
  }
  try { await fsyncDirectory(directory); }
  catch { warnings.push("published; syncing the directory failed"); }
  return { path: target, bytes: data.byteLength, revision: revisionFromBytes(data), warnings };
}

/** Encodes and reads the owner record stored inside a cooperative lock file. */
export interface LockOwnerCodec {
  encode(pid: number): string;
  decode(raw: string): number | undefined;
}

/** The plain-text `"<pid>\\n"` owner record. */
export const pidOwnerCodec: LockOwnerCodec = {
  encode(pid: number): string {
    return `${pid}\n`;
  },
  decode(raw: string): number | undefined {
    if (!/^[1-9][0-9]*\s*$/.test(raw)) return undefined;
    const pid = Number(raw.trim());
    return Number.isSafeInteger(pid) && pid <= 2147483647 ? pid : undefined;
  },
};

/** Names the lock file for one target; products keep their stable scheme. */
export type LockNamePolicy = (target: string) => string;

/**
 * Digest-based lock name shared by every carrier of one product, including
 * non-Node implementations: the key is hashed and truncated, so aliases of
 * one path family map to stable names without embedding the path itself.
 */
export function hashedLockName(
  key: string,
  options: { prefix: string; digestLength?: number },
): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `${options.prefix}${digest.slice(0, options.digestLength ?? 32)}`;
}

/** Windows lock-key normalization: backslash separators and verbatim cleanup. */
export function windowsLockKey(filePath: string): string {
  const normalized = filePath.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${normalized.slice(8)}`;
  }
  if (normalized.startsWith("\\\\?\\")) return normalized.slice(4);
  return normalized;
}

/**
 * Laniakea-compatible lock path: the key is the exact target path (Windows
 * normalized), hashed to `<prefix><digest32>` beside the target.
 */
export function laniakeaLockPath(target: string, platform: NodeJS.Platform = process.platform): string {
  const key = platform === "win32" ? windowsLockKey(target) : target;
  const paths = platform === "win32" ? win32Path : path;
  return paths.join(paths.dirname(target), hashedLockName(key, { prefix: ".laniakea-lock-" }));
}

/** What was observed about a held lock when deciding whether it is stale. */
export interface StaleObservation {
  ageMs: number;
  ownerPid?: number;
  ownerAlive: boolean;
}

export interface LockPolicy {
  owner: LockOwnerCodec;
  /** Decide staleness from the observation; live owners must never be stale. */
  isStale: (observation: StaleObservation) => boolean;
  timeoutMs: number;
  retryMs: number;
  /** Auxiliary failure after the operation; this callback must not throw. */
  onWarning?: (message: string) => void;
}

export interface LockHandle {
  lockPath: string;
  release(): Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

async function ownerIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function observeLock(
  lockPath: string,
  policy: LockPolicy,
): Promise<
  | { state: "missing" }
  | { state: "held"; ino: number; mtimeMs: number; stale: boolean }
> {
  const metadata = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (metadata === undefined) return { state: "missing" };
  const ageMs = Date.now() - metadata.mtimeMs;
  let ownerPid: number | undefined;
  let ownerAlive = true;
  let raw = "";
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (handle) {
    try {
      const stat = await handle.stat();
      if (stat.isFile() && stat.ino === metadata.ino && stat.size <= 1024) {
        const buffer = Buffer.alloc(1025);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead <= 1024) raw = buffer.subarray(0, read.bytesRead).toString("utf8");
      }
    } finally { await handle.close(); }
  }
  ownerPid = policy.owner.decode(raw);
  if (ownerPid !== undefined) ownerAlive = await ownerIsAlive(ownerPid);
  return {
    state: "held",
    ino: metadata.ino,
    mtimeMs: metadata.mtimeMs,
    stale: !ownerAlive && policy.isStale({ ageMs, ...(ownerPid === undefined ? {} : { ownerPid }), ownerAlive }),
  };
}

/** Remove a validated stale lock only if it is still the exact observed file. */
async function removeStaleUnlocked(
  lockPath: string,
  observed: { ino: number; mtimeMs: number },
): Promise<boolean> {
  const current = await lstat(lockPath).catch(() => null);
  if (!current) return true;
  if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw new ArtifactStoreError("IO", "the stale lock could not be removed");
  }
}

/** Serialize stale-observation removal with new cooperating owners. */
export async function removeStaleLockIfUnchanged(lockPath: string, observed: { ino: number; mtimeMs: number }): Promise<boolean> {
  return withArtifactWriteLock(lockPath, () => removeStaleUnlocked(lockPath, observed));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Run `work` while holding the cooperative lock file for `target`.
 *
 * The lock is claimed by exclusive creation and holds the owner record. A
 * held lock is removed only when the consumer's stale rule accepts it and the
 * exact observed file is still in place, so two processes can never delete a
 * newer owner's lock. On Windows a removed lock can stay pending until
 * concurrent readers close it; only lock acquisition is retried there, never
 * an error from initializing our own lock. Release removes only our own file.
 */
async function withLockFileUnlocked<T>(
  lockPath: string,
  policy: LockPolicy,
  work: () => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + policy.timeoutMs;
  let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
  while (lockHandle === null) {
    try {
      const candidate = await open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(policy.owner.encode(process.pid), "utf8");
        await candidate.sync();
        lockHandle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (
        process.platform === "win32" &&
        (isErrno(error, "EPERM") || isErrno(error, "EACCES")) &&
        performance.now() < deadline
      ) {
        await delay(policy.retryMs);
        continue;
      }
      if (!isErrno(error, "EEXIST")) {
        throw new ArtifactStoreError("IO", "the lock could not be created");
      }
      const observation = await observeLock(lockPath, policy);
      let removed = observation.state === "missing";
      if (observation.state === "held" && observation.stale) {
        removed = await removeStaleUnlocked(lockPath, {
          ino: observation.ino,
          mtimeMs: observation.mtimeMs,
        });
      }
      if (removed) continue;
      if (performance.now() >= deadline) {
        throw new ArtifactStoreError("BUSY", "another holder still owns the lock");
      }
      await delay(policy.retryMs);
    }
  }
  try {
    return await work();
  } finally {
    const owned = await lockHandle.stat().catch(() => undefined);
    const current = await lstat(lockPath).catch(() => undefined);
    await lockHandle.close().catch(() => { try { policy.onWarning?.("completed; closing the product lock failed"); } catch {} });
    if (owned && current && owned.dev === current.dev && owned.ino === current.ino) await unlink(lockPath).catch(() => { try { policy.onWarning?.("completed; releasing the product lock failed"); } catch {} });
  }
}

/** Retain a product's legacy lock under a unique-owner recovery guard. */
export async function withLockFile<T>(lockPath: string, policy: LockPolicy, work: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + policy.timeoutMs;
  return withArtifactWriteLock(lockPath, () => withLockFileUnlocked(lockPath, {...policy, timeoutMs: Math.max(0, deadline - performance.now())}, work), policy.timeoutMs, policy.onWarning);
}
