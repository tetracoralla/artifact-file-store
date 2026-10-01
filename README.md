# openadam-artifact-file-store

Apache-2.0 library extracted from Calligram and Laniakea. It owns the safe single-file artifact storage guarantees local
tools need when a whole artifact lives in one file:

- byte-exact revision identity (a leading BOM or CRLF change always changes
  the revision, because it is derived from the bytes, never from decoded
  text);
- atomic publication with explicit authority: exclusive `create` (never
  overwrites) and `replace` (same-directory temporary, fsync, rename, mode
  preservation, directory sync). A failure after the rename is reported as a
  committed write with bounded warnings, never as "nothing was written";
- cooperative cross-process lock files under a unique-owner guard: exclusive claim, owner record,
  consumer-supplied stale rule, with live/unknown owners always protected, and
  removal re-checked against the exact observed file so two processes cannot
  delete a newer owner's lock;
- digest lock naming (`laniakeaLockPath` / `hashedLockName` normalization) with
  a versioned fixture (`fixtures/artifact-file-store-fixture.json`) that any
  non-Node carrier can implement against the same vectors.

## Install and quick start

Install the versioned [GitHub release artifact](https://github.com/tetracoralla/artifact-file-store/releases/tag/v0.2.5) directly:

```sh
npm install https://github.com/tetracoralla/artifact-file-store/releases/download/v0.2.5/openadam-artifact-file-store-0.2.5.tgz
```

Once this version is available on npm, registry installation is:

```sh
npm install openadam-artifact-file-store@0.2.5
```

```js
import { writeArtifactFile, withArtifactWriteLock } from "openadam-artifact-file-store";

const result = await withArtifactWriteLock("./draft.md", () =>
  writeArtifactFile("./draft.md", "# Draft\n", { kind: "create" })
);
console.log(result.revision, result.warnings);
```

The parent directory must exist and be authorized by the application. `create`
refuses to overwrite an existing file. Use `replace` only with explicit overwrite
authority; applications compare the expected revision inside the same lock before
replacing. Inspect warnings even after success: publication can succeed while an
auxiliary sync or cleanup fails. No workspace grants are provided by this library.

ESM, Node >= 22, zero runtime dependencies. TypeScript applications use
`@types/node` for the Node platform types in the public declarations. The write/lock operations are tested
on macOS and Linux, on local filesystems providing hard links and atomic rename.
Windows path-key fixtures are provided for interoperability, but a complete
Windows persistence guarantee and network-filesystem behavior are not established.
The SHA-256 fixture and protocol version remain stable independently of package
patch versions. See [RELEASING.md](RELEASING.md) for verified release artifacts.

## Scope deliberately left to products

Lock naming schemes beyond the shared helper, owner-record formats (a codec is
injected), stale rules and their public error codes/messages, content parsing
or normalization, multi-file transactions, journals, and recovery. The library
accepts bytes and explicit policy; it never parses Markdown. Cooperative
guarantees only: an uncooperative external editor does not take the lock, and
a plain rename is not a general compare-and-swap; expected-revision checks
remain the caller's step before `replace`.

## Compared with write-file-atomic (2026-10-01)

[`write-file-atomic@8.0.0`](https://github.com/npm/write-file-atomic/blob/v8.0.0/README.md)
(ISC) supplies temporary writes, fsync, rename, mode/ownership preservation,
exit cleanup and an in-process queue. Its
[Node requirement](https://github.com/npm/write-file-atomic/blob/v8.0.0/package.json)
is `^22.22.2 || ^24.15.0 || >=26.0.0`, above the consumers' Node 22 floor.
Exclusive-create authority, cross-process owner recovery, revision checks and
committed auxiliary warnings would still need a separate implementation.
The shared package therefore retains the products' publication mechanism;
revision checks and multi-file recovery remain product responsibilities.

## API

```ts
import {
  ArtifactStoreError,
  laniakeaLockPath,
  pidOwnerCodec,
  revisionFromBytes,
  revisionFromText,
  withLockFile,
  writeArtifactFile,
} from "openadam-artifact-file-store";
```

- `revisionFromBytes(bytes, { prefix })` / `revisionFromText(text, { prefix })`.
- `writeArtifactFile(target, content, { kind: "create", mode? })` or
  `{ kind: "replace", mode?, temporaryPrefix? }` → `{ path, bytes, revision,
  warnings }`; rejects with `ArtifactStoreError` (`EXISTS`, `BUSY`, `IO`).
- `withLockFile(lockPath, { owner, isStale, timeoutMs, retryMs }, work)` →
  runs `work` while holding the lock; rejects `BUSY` after the timeout.

## Common artifact protocol v1

`withArtifactWriteLock(target, work, timeoutMs?, onWarning?)` serializes participating
products before their legacy product locks. It uses a populated directory
beside the canonical parent, with one `owner-<hostSHA16>-<pid>-<uuid>` marker.
Confirmed dead local owners can be recovered; live, foreign, and malformed
owners fail closed. Cleanup removes only the unique marker and an empty
directory, never a recursively removed shared lock. Directory aliases and
case/NFC aliases serialize conservatively; this does not equate their file
identity or revision. The shared fixture defines basename hash vectors.

Calligram, Laniakea Node and Laniakea Rust take the common guard before their
old locks. Thus upgraded carriers cooperate across products and still honor
older same-product holders. Old versions do not recognize the new cross-product
guard; cross-product guarantees require upgraded participants. Live Studio
retains its project transaction lock/journal; it uses common publication only.
Uncooperative external editors and arbitrary legacy versions are outside this
protocol's guarantee. The guard is non-reentrant; do not acquire it recursively
for the same target. Recovery callbacks and product revision checks run inside
its ownership interval.

Exclusive create stages and syncs all bytes before a hard-link publication;
readers never observe a partial final file. Replace publishes by rename. Any
pre-publication failure removes the private staging name. Post-publication
staging cleanup or directory-sync failures return committed warnings. Products
map those warnings into their existing observable result/recovery models.
Lock release failures are auxiliary warnings delivered to `onWarning`; callers
collect them with the successful result rather than retrying a completed write.

## Maintenance

Node >= 22, ESM, zero runtime dependencies; `npm test` builds and runs the
`node --test` suite, which consumes the shared fixture. Consume packed
tarballs with a recorded SHA-256; `npm pack` output is not byte-reproducible,
so changed bytes require a new version or a distinguished revision hash.
