// Verify the actual tarball, public declarations and independent installation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "run this check through npm run check:package");
const temporary = mkdtempSync(join(tmpdir(), "package check "));
const run = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
try {
  const [packed] = JSON.parse(run(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root));
  const files = packed.files.map(file => file.path);
  for (const file of ["package.json", "README.md", "LICENSE", "NOTICE", "dist/index.js", "dist/index.d.ts"]) assert.ok(files.includes(file), `missing ${file}`);
  for (const file of files) assert.match(file, /^(?:dist\/|fixtures\/|package\.json$|README\.md$|LICENSE$|NOTICE$|CHANGELOG\.md$)/, `unexpected release file ${file}`);
  const consumer = join(temporary, "fresh consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({private: true, type: "module"}));
  run(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", join(temporary, packed.filename)], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, "node_modules", metadata.name, "package.json"), "utf8"));
  assert.equal(installed.version, metadata.version);
  assert.equal(installed.license, "Apache-2.0");
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
  const exact = metadata.name === "@openadam/exact-intervals";
  const code = exact ? `
import {subtractIntervals, intersectSourcedIntervals, overlapsIntervals} from '${metadata.name}';
import assert from 'node:assert/strict';
const endpoint = 9007199254740993n;
assert.deepEqual(subtractIntervals([{start:endpoint,end:endpoint+10n}], [{start:endpoint+3n,end:endpoint+6n}]), [{start:endpoint,end:endpoint+3n},{start:endpoint+6n,end:endpoint+10n}]);
assert.deepEqual(overlapsIntervals([{start:0n,end:1n},{start:1n,end:2n}]), []);
const pieces=intersectSourcedIntervals([{start:0n,end:4n,sources:new Set(['left'])}], [{start:2n,end:6n,sources:new Set(['right'])}]);
assert.deepEqual([...pieces[0].sources].sort(), ['left','right']);
` : `
import {writeArtifactFile,withArtifactWriteLock,revisionFromBytes,artifactLockName} from '${metadata.name}';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
const target=join(process.cwd(),'artifact.md');
const bytes=Buffer.from('\ufeffhello\\r\\n');
const first=await withArtifactWriteLock(target,()=>writeArtifactFile(target,bytes,{kind:'create'}));
assert.equal(first.revision,revisionFromBytes(bytes));
assert.deepEqual(await readFile(target),bytes);
await assert.rejects(writeArtifactFile(target,'overwrite',{kind:'create'}), error=>error.causeKind==='EXISTS');
let counter=0;
await Promise.all(Array.from({length:4},()=>withArtifactWriteLock(target,async()=>{const old=counter;await new Promise(r=>setTimeout(r,5));counter=old+1;})));
assert.equal(counter,4);
await withArtifactWriteLock(target,()=>writeArtifactFile(target,'continued',{kind:'replace'}));
assert.equal(await readFile(target,'utf8'),'continued');
assert.ok(!(await readdir(process.cwd())).includes(artifactLockName('artifact.md')));
`;
  writeFileSync(join(consumer, "smoke.mjs"), code);
  execFileSync(process.execPath, ["smoke.mjs"], {cwd:consumer, stdio:"pipe"});
  if (!exact) {
    const nodeTypes = JSON.parse(readFileSync(join(root, "node_modules/@types/node/package.json"), "utf8"));
    run(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--save-dev", `@types/node@${nodeTypes.version}`], consumer);
  }
  const types = exact ? `import {type ExactInterval,subtractIntervals} from '${metadata.name}'; const a:ExactInterval={start:1n,end:2n}; const b:ExactInterval[]=subtractIntervals([a],[]); void b;` : `import {type WriteResult,writeArtifactFile,withArtifactWriteLock} from '${metadata.name}'; const result:Promise<WriteResult>=withArtifactWriteLock('artifact.md',()=>writeArtifactFile('artifact.md','x',{kind:'create'})); void result;`;
  writeFileSync(join(consumer, "types.mts"), types);
  execFileSync(process.execPath, [join(root,"node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "types.mts"], {cwd:consumer, stdio:"pipe"});
  console.log(`PASS: ${metadata.name}@${metadata.version}, ${files.length} release files, independent API and declarations`);
} finally {rmSync(temporary,{recursive:true,force:true});}
