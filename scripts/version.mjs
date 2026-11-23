#!/usr/bin/env node
// Release version helper. VERSION.md (first line) is the single source of truth.
//
//   node scripts/version.mjs get            print the version from VERSION.md
//   node scripts/version.mjs sync           write it into every package.json, package-lock.json and src/version.ts
//   node scripts/version.mjs check          exit 1 if any file is out of sync with VERSION.md
//   node scripts/version.mjs release-check  compare with the latest v* git tag (key=value lines for $GITHUB_OUTPUT)
//   node scripts/version.mjs notes [ver]    print the CHANGELOG.md section for a version
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function readVersion() {
  const text = readFileSync(join(root, "VERSION.md"), "utf8");
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const v = first
    .trim()
    .replace(/^(?:#+\s*)?(?:version\s*:?\s*)?v?/i, "")
    .trim();
  if (!SEMVER.test(v)) throw new Error(`VERSION.md: first line must be a semantic version like 1.2.3, got "${first}"`);
  return v;
}

export function compare(a, b) {
  const pa = a.match(SEMVER);
  const pb = b.match(SEMVER);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (!pa[4] && !pb[4]) return 0;
  if (!pa[4]) return 1; // 1.0.0 > 1.0.0-rc.1
  if (!pb[4]) return -1;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Math.sign(Number(xa[i]) - Number(xb[i]));
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

function workspaces() {
  const dir = join(root, "packages");
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "package.json")))
    .map((d) => ({ path: `packages/${d}`, file: join(dir, d, "package.json") }));
}

function plan(version) {
  const changes = new Map(); // file -> new text
  const pkgs = workspaces();
  const names = new Set(pkgs.map((p) => JSON.parse(readFileSync(p.file, "utf8")).name));
  const bump = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (typeof obj.version === "string") obj.version = version;
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(obj[key] ?? {})) if (names.has(dep)) obj[key][dep] = version;
    }
  };
  const put = (file, next) => {
    if (readFileSync(file, "utf8") !== next) changes.set(file, next);
  };
  for (const p of pkgs) {
    const json = JSON.parse(readFileSync(p.file, "utf8"));
    bump(json);
    put(p.file, `${JSON.stringify(json, null, 2)}\n`);
    const vfile = join(root, p.path, "src", "version.ts");
    if (existsSync(vfile)) {
      const src = readFileSync(vfile, "utf8");
      put(vfile, src.replace(/(export const VERSION = ")[^"]*(")/, `$1${version}$2`));
    }
  }
  const lockFile = join(root, "package-lock.json");
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    for (const p of pkgs) bump(lock.packages?.[p.path]);
    put(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  }
  return changes;
}

function latestTag() {
  let tags = [];
  try {
    tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((t) => t.trim().replace(/^v/, ""))
      .filter((t) => SEMVER.test(t));
  } catch {
    // not a git checkout
  }
  return tags.sort(compare).at(-1) ?? null;
}

export function changelogSection(version) {
  const file = join(root, "CHANGELOG.md");
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const esc = version.replace(/[.+]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`).test(l));
  if (start < 0) return "";
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

const [cmd = "get", arg] = process.argv.slice(2);
const version = readVersion();
if (cmd === "get") {
  console.log(version);
} else if (cmd === "sync") {
  const changes = plan(version);
  for (const [file, text] of changes) writeFileSync(file, text);
  console.log(
    changes.size
      ? `Synced ${version} into:\n${[...changes.keys()].map((f) => `  ${f.slice(root.length + 1)}`).join("\n")}`
      : `All files already at ${version}`,
  );
} else if (cmd === "check") {
  const changes = plan(version);
  if (changes.size) {
    console.error(`Out of sync with VERSION.md (${version}): ${[...changes.keys()].join(", ")}`);
    console.error("Run: node scripts/version.mjs sync");
    process.exit(1);
  }
  console.log(`All package versions match VERSION.md (${version})`);
} else if (cmd === "release-check") {
  const latest = latestTag();
  const release = latest === null || compare(version, latest) > 0;
  const prerelease = version.includes("-");
  const msg = release
    ? `Releasing v${version} (latest tag: ${latest ? `v${latest}` : "none"}).`
    : `Skipping release: VERSION.md is ${version}, which is not greater than the latest tag v${latest}. Bump VERSION.md to publish.`;
  console.log(`version=${version}\nlatest=${latest ?? ""}\nrelease=${release}\nprerelease=${prerelease}`);
  console.error(msg);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release check\n\n${msg}\n`);
} else if (cmd === "notes") {
  const v = arg ?? version;
  console.log(changelogSection(v) || `Release v${v}. See CHANGELOG.md for details.`);
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(2);
}
