import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, lstat, readFile, rm, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/index.js", import.meta.url);
const fixture = JSON.parse(await readFile(new URL("../fixtures/artifact-file-store-fixture.json", import.meta.url), "utf8"));
const {
  ArtifactStoreError,
  laniakeaLockPath,
  pidOwnerCodec,
  revisionFromBytes,
  revisionFromText,
  withLockFile,
  writeArtifactFile,
} = await import(dist.href);

async function withTempDir() {
  const root = await mkdtemp(join(tmpdir(), "artifact-store-"));
  return [root, () => rm(root, { recursive: true, force: true })];
}

test("fixture: revisions are byte-exact across prefixes, BOM, CRLF, and multibyte", () => {
  for (const entry of fixture.revisions) {
    const bytes = Buffer.from(entry.bytesHex, "hex");
    assert.equal(revisionFromBytes(bytes, { prefix: entry.prefix }), entry.expected);
    assert.equal(revisionFromText(bytes.toString("utf8"), { prefix: entry.prefix }), entry.expected);
  }
  const bom = fixture.revisions.find((entry) => entry.bytesHex.startsWith("efbbbf"));
  const stripped = Buffer.from(bom.bytesHex.slice(6), "hex");
  assert.notEqual(revisionFromBytes(stripped), bom.expected, "BOM must change the revision");
});

test("fixture: lock keys and laniakea lock naming match the shared vectors", () => {
  const pathsByPlatform = { posix: path.posix, win32: path.win32 };
  for (const entry of fixture.lockKeys) {
    const paths = pathsByPlatform[entry.platform];
    const lock = laniakeaLockPath(entry.path, entry.platform);
    assert.equal(
      lock,
      paths.join(paths.dirname(entry.path), `${fixture.lockName.prefix}${entry.expectedDigest}`),
      entry.path,
    );
  }
  assert.equal(pidOwnerCodec.decode(fixture.owner.parseableExamples[1]), 1);
  for (const invalid of fixture.owner.invalidExamples) {
    assert.equal(pidOwnerCodec.decode(invalid), undefined);
  }
  for (const nonPositive of fixture.owner.nonPositiveExamples) {
    assert.equal(pidOwnerCodec.decode(nonPositive), undefined, "never a dead owner");
  }
});

test("create is exclusive, fsynced, and removes only its own partial file", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const target = join(root, "doc.md");
    const first = await writeArtifactFile(target, "# one\n", { kind: "create" });
    assert.equal(first.revision, revisionFromText("# one\n"));
    await assert.rejects(
      () => writeArtifactFile(target, "# two\n", { kind: "create" }),
      (error) => error instanceof ArtifactStoreError && error.causeKind === "EXISTS",
    );
    assert.equal(await readFile(target, "utf8"), "# one\n");
    const mode = (await stat(target)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await cleanup();
  }
});

test("replace preserves mode, publishes atomically, and reports committed with warnings", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const target = join(root, "doc.md");
    await writeFile(target, "# old\n", "utf8");
    await chmod(target, 0o640);
    const result = await writeArtifactFile(target, "# new\n", { kind: "replace" });
    assert.equal(result.bytes, 6);
    assert.equal(result.revision, revisionFromText("# new\n"));
    assert.deepEqual(result.warnings, []);
    assert.equal(await readFile(target, "utf8"), "# new\n");
    assert.equal((await stat(target)).mode & 0o777, 0o640);
    const leftovers = [];
    for (const entry of await (await import("node:fs/promises")).readdir(root)) {
      if (entry.includes(".tmp")) leftovers.push(entry);
    }
    assert.deepEqual(leftovers, []);
  } finally {
    await cleanup();
  }
});

test("replace rejects a non-regular target and never touches its bytes", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const symlinkTarget = join(root, "real.md");
    await writeFile(symlinkTarget, "# keep\n", "utf8");
    const link = join(root, "link.md");
    await (await import("node:fs/promises")).symlink(symlinkTarget, link);
    await assert.rejects(
      () => writeArtifactFile(link, "# x\n", { kind: "replace" }),
      (error) => error instanceof ArtifactStoreError && error.causeKind === "IO",
    );
    assert.equal(await readFile(symlinkTarget, "utf8"), "# keep\n");
  } finally {
    await cleanup();
  }
});

function eagerStalePolicy({ timeoutMs = 200, retryMs = 10 } = {}) {
  return {
    owner: pidOwnerCodec,
    isStale: (observation) => !observation.ownerAlive,
    timeoutMs,
    retryMs,
  };
}

test("lock: serializes two processes and releases cleanly", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const lockPath = laniakeaLockPath(join(root, "doc.md"));
    const order = [];
    await withLockFile(lockPath, eagerStalePolicy(), async () => {
      order.push("first-enter");
      const second = spawn(process.execPath, ["-e", `
        import(${JSON.stringify(dist.href)}).then(async (m) => {
          try {
            await m.withLockFile(${JSON.stringify(lockPath)}, {
              owner: m.pidOwnerCodec,
              isStale: () => false,
              timeoutMs: 150,
              retryMs: 10,
            }, async () => "held");
            console.log("unexpectedly-held");
          } catch (error) {
            console.log(error.causeKind ?? "other");
          }
        });
      `]);
      const output = await new Promise((resolve) => {
        let text = "";
        second.stdout.on("data", (chunk) => { text += chunk; });
        second.on("close", () => resolve(text.trim()));
      });
      assert.equal(output, "BUSY");
      order.push("first-exit");
    });
    assert.deepEqual(order, ["first-enter", "first-exit"]);
    // The released lock is gone and the next holder succeeds immediately.
    await withLockFile(lockPath, eagerStalePolicy(), async () => "ok");
    assert.equal(await lstat(lockPath).catch(() => null), null);
  } finally {
    await cleanup();
  }
});

test("lock: recovers a dead owner's stale lock without stealing a live one", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const target = join(root, "doc.md");
    const lockPath = laniakeaLockPath(target);
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = await new Promise((resolve) => dead.on("exit", () => resolve(dead.pid)));
    await writeFile(lockPath, `${deadPid}\n`, "utf8");
    await withLockFile(lockPath, eagerStalePolicy(), async () => {
      assert.ok((await lstat(lockPath)).isFile());
    });

    // A live owner is never stale under the dead-owner-only rule.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(lockPath, `${holder.pid}\n`, "utf8");
    await assert.rejects(
      () => withLockFile(lockPath, eagerStalePolicy({ timeoutMs: 150 }), async () => "held"),
      (error) => error instanceof ArtifactStoreError && error.causeKind === "BUSY",
    );
    assert.ok((await lstat(lockPath)).isFile(), "the live owner's lock must survive");
    holder.kill();
  } finally {
    await cleanup();
  }
});

test("lock: a newer lock is never removed by a stale observation", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const lockPath = laniakeaLockPath(join(root, "doc.md"));
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = await new Promise((resolve) => dead.on("exit", () => resolve(dead.pid)));
    // A stale-looking lock that is replaced between observation and removal
    // must not be deleted: simulate by pointing the observation at the old
    // file's identity after a new lock has taken its place.
    const first = { inode: 1, mtimeMs: 1 };
    await writeFile(lockPath, `${deadPid}\n`, "utf8");
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await unlink(lockPath);
    await writeFile(lockPath, `${holder.pid}\n`, "utf8");
    const current = await lstat(lockPath);
    assert.notEqual(current.ino, first.ino);
    // The library refuses to remove when the identity changed; the live
    // holder's lock is still present after a contended attempt times out.
    await assert.rejects(
      () => withLockFile(lockPath, eagerStalePolicy({ timeoutMs: 120 }), async () => "held"),
      (error) => error instanceof ArtifactStoreError && error.causeKind === "BUSY",
    );
    assert.ok((await lstat(lockPath)).isFile());
    holder.kill();
  } finally {
    await cleanup();
  }
});

test("repeated save/read cycles return to a clean directory", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const target = join(root, "doc.md");
    await writeArtifactFile(target, "v0\n", { kind: "create" });
    for (let index = 1; index <= 20; index += 1) {
      const result = await writeArtifactFile(target, `v${index}\n`, { kind: "replace" });
      assert.equal(result.revision, revisionFromText(`v${index}\n`));
    }
    assert.equal(await readFile(target, "utf8"), "v20\n");
    const entries = await (await import("node:fs/promises")).readdir(root);
    assert.deepEqual(entries, ["doc.md"]);
  } finally {
    await cleanup();
  }
});

test("failed staging writes clean up create and replace without publishing partial bytes", async () => {
  const { open, readdir } = await import("node:fs/promises");
  const [root, cleanup] = await withTempDir();
  const probe = await open(join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.writeFile;
  await probe.close(); await unlink(join(root, "probe"));
  try {
    const target = join(root, "doc.md"); await writeFile(target, "keep");
    prototype.writeFile = async function () { throw Object.assign(new Error("disk full"), {code: "ENOSPC"}); };
    await assert.rejects(writeArtifactFile(target, "new", {kind: "replace"}), error => error.causeKind === "IO");
    await assert.rejects(writeArtifactFile(join(root, "new.md"), "new", {kind: "create"}), error => error.causeKind === "IO");
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.deepEqual(await readdir(root), ["doc.md"]);
  } finally { prototype.writeFile = original; await cleanup(); }
});

test("exclusive creation is invisible until all bytes have been staged", async () => {
  const { open } = await import("node:fs/promises");
  const [root, cleanup] = await withTempDir();
  const probe = await open(join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe); const original = prototype.writeFile;
  await probe.close(); await unlink(join(root, "probe"));
  const target = join(root, "doc.md");
  try {
    prototype.writeFile = async function (...args) {
      assert.equal(await lstat(target).catch(() => null), null);
      return original.apply(this, args);
    };
    await writeArtifactFile(target, "x".repeat(10000), {kind: "create"});
    assert.equal((await readFile(target)).length, 10000);
  } finally { prototype.writeFile = original; await cleanup(); }
});

test("live and unknown legacy owners survive an unsafe age-based consumer policy", async () => {
  const { utimes, symlink } = await import("node:fs/promises");
  const [root, cleanup] = await withTempDir();
  try {
    const lock = join(root, "legacy.lock");
    const policy = {...eagerStalePolicy({timeoutMs: 30}), isStale: () => true};
    for (const text of [`${process.pid}\n`, "123junk", "x".repeat(2000)]) {
      await writeFile(lock, text); await utimes(lock, 1, 1);
      await assert.rejects(withLockFile(lock, policy, async () => {}), e => e.causeKind === "BUSY");
      assert.equal(await readFile(lock, "utf8"), text); await unlink(lock);
    }
    if (process.platform !== "win32") {
      assert.equal(spawnSync("mkfifo", [lock]).status, 0);
      await assert.rejects(withLockFile(lock, policy, async () => {}), e => e.causeKind === "BUSY");
      await unlink(lock);
    }
  } finally { await cleanup(); }
});

test("old cleanup cannot release another legacy owner or remove a replaced observation", async () => {
  const { removeStaleLockIfUnchanged } = await import(dist.href);
  const [root, cleanup] = await withTempDir();
  try {
    const lock = join(root, "legacy.lock");
    let old;
    await withLockFile(lock, eagerStalePolicy(), async () => {
      old = await lstat(lock);
      // Keep the old inode allocated to make reuse impossible in this probe.
      await (await import("node:fs/promises")).rename(lock, join(root, "old"));
      await writeFile(lock, "new owner");
    });
    assert.equal(await removeStaleLockIfUnchanged(lock, {ino: old.ino, mtimeMs: old.mtimeMs}), false);
    assert.equal(await readFile(lock, "utf8"), "new owner");
  } finally { await cleanup(); }
});


test("common protocol locks aliases and recovers confirmed dead unique owners", async () => {
  const { artifactLockName, withArtifactWriteLock } = await import(dist.href);
  const { mkdir, readdir, symlink, rename } = await import("node:fs/promises");
  for (const vector of fixture.artifactLock.nameVectors) assert.equal(artifactLockName(vector.basename), vector.expected);
  const [root, cleanup] = await withTempDir();
  try {
    const target = join(root, "doc.md");
    const alias = join(root, "alias"); await symlink(root, alias);
    await withArtifactWriteLock(target, async () => {
      await assert.rejects(withArtifactWriteLock(join(alias, "doc.md"), async () => {}, 20), e => e.causeKind === "BUSY");
    });
    const lock = join(root, artifactLockName(target));
    const { createHash } = await import("node:crypto");
    const { hostname } = await import("node:os");
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise(r => dead.on("exit", r));
    const owner = `owner-${createHash("sha256").update(hostname()).digest("hex").slice(0,16)}-${dead.pid}-00000000-0000-0000-0000-000000000000`;
    await mkdir(lock); await writeFile(join(lock, owner), "");
    await withArtifactWriteLock(target, async () => {});
    assert.equal(await lstat(lock).catch(() => null), null);
    // A displaced holder's cleanup can never remove its replacement.
    await withArtifactWriteLock(target, async () => {
      await rename(lock, join(root, "displaced"));
      await mkdir(lock); await writeFile(join(lock, "foreign-owner"), "");
    });
    assert.deepEqual(await readdir(lock), ["foreign-owner"]);
  } finally { await cleanup(); }
});

test("directory sync failure is a committed warning, never an ordinary write failure", async () => {
  const { open, readdir } = await import("node:fs/promises");
  const [root, cleanup] = await withTempDir();
  const probe = await open(join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe); const sync = prototype.sync;
  await probe.close(); await unlink(join(root, "probe"));
  try {
    prototype.sync = async function () { if ((await this.stat()).isDirectory()) throw new Error("directory sync failed"); return sync.call(this); };
    for (const kind of ["create", "replace"]) {
      const target = join(root, "doc.md");
      const result = await writeArtifactFile(target, kind, {kind});
      assert.equal(await readFile(target, "utf8"), kind);
      assert.deepEqual(result.warnings, ["published; syncing the directory failed"]);
    }
    assert.deepEqual(await readdir(root), ["doc.md"]);
  } finally { prototype.sync = sync; await cleanup(); }
});

test("incomplete artifact lock cleanup preserves unknown bytes and reports an auxiliary warning", async () => {
  const { artifactLockName, withArtifactWriteLock } = await import(dist.href);
  const [root, cleanup] = await withTempDir();
  try {
    const target = join(root, "doc.md");
    const extra = join(root, artifactLockName(target), "unknown-entry");
    const warnings = [];
    const result = await withArtifactWriteLock(target, async () => {
      await writeFile(extra, "preserve");
      return "committed";
    }, 100, warning => warnings.push(warning));
    assert.equal(result, "committed");
    assert.deepEqual(warnings, ["completed; releasing the artifact lock failed"]);
    assert.equal(await readFile(extra, "utf8"), "preserve");
  } finally { await cleanup(); }
});

test("failed stale-lock unlink returns IO instead of retrying forever", {skip: process.platform === "win32" || process.getuid?.() === 0}, async () => {
  const [root, cleanup] = await withTempDir();
  const { chmodSync } = await import("node:fs");
  try {
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {encoding: "utf8"});
    const lock = join(root, "legacy.lock");
    await writeFile(lock, dead.stdout.trim() + "\n");
    const code = `import {chmodSync} from 'node:fs'; import {withLockFile,pidOwnerCodec} from ${JSON.stringify(dist.href)};
      try { await withLockFile(${JSON.stringify(lock)}, {owner:pidOwnerCodec,timeoutMs:50,retryMs:1,isStale:()=>{chmodSync(${JSON.stringify(root)},0o500);return true}},async()=>{}); }
      catch(e) { console.log(e.causeKind); } finally {chmodSync(${JSON.stringify(root)},0o700);}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {encoding: "utf8", timeout: 3000});
    assert.equal(result.error, undefined, "stale-removal failure must settle");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "IO");
    assert.equal(await readFile(lock, "utf8"), dead.stdout.trim() + "\n");
  } finally { chmodSync(root, 0o700); await cleanup(); }
});

test("legacy lock wait expires even when the wall clock is frozen", async () => {
  const [root, cleanup] = await withTempDir();
  try {
    const lock = join(root, "legacy.lock");
    await writeFile(lock, `${process.pid}\n`);
    const code = `import {withLockFile,pidOwnerCodec} from ${JSON.stringify(dist.href)};
      Date.now=()=>0;
      try { await withLockFile(${JSON.stringify(lock)}, {owner:pidOwnerCodec,timeoutMs:50,retryMs:1,isStale:()=>false},async()=>{}); }
      catch(e) { console.log(e.causeKind); }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {encoding: "utf8", timeout: 3000});
    assert.equal(result.error, undefined, "wait must use monotonic time");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "BUSY");
  } finally { await cleanup(); }
});

test("post-commit descriptor close failures remain observable auxiliary warnings", async () => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const [root, cleanup] = await withTempDir();
  const originalOpen = fs.promises.open;
  let lockInode;
  try {
    fs.promises.open = async function (...args) {
      const handle = await originalOpen(...args), originalClose = handle.close.bind(handle);
      handle.close = async () => {
        const metadata = await handle.stat();
        await originalClose();
        if (metadata.isDirectory() || metadata.ino === lockInode) throw new Error("close failed");
      };
      return handle;
    };
    syncBuiltinESMExports();
    const target = join(root, "doc.md");
    const written = await writeArtifactFile(target, "saved", {kind: "create"});
    assert.equal(written.warnings.length, 1);
    assert.equal(await readFile(target, "utf8"), "saved");
    const lock = join(root, "legacy.lock"), warnings = [];
    const result = await withLockFile(lock, {...eagerStalePolicy(), onWarning: w => warnings.push(w)}, async () => {
      lockInode = (await lstat(lock)).ino;
      return "committed";
    });
    assert.equal(result, "committed");
    assert.deepEqual(warnings, ["completed; closing the product lock failed"]);
    assert.equal(await lstat(lock).catch(() => null), null);
  } finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); await cleanup(); }
});
