#!/usr/bin/env node
/**
 * Refresh vendor/koc-registry/ from the KOC Design System at a given tag.
 *
 *   npm run koc:sync -- v0.1.2
 *   npm run koc:sync -- v0.1.2 --from ~/Documents/Claude/Projects/KOC\ Design\ System
 *
 * Run by whoever maintains the design system, not by the app developer: it needs
 * access to that repo. The result is a diff in this repo, so a design-system
 * update arrives as a reviewable commit rather than as a silent fetch.
 *
 * IMPORTANT, AND EASY TO GET WRONG
 * --------------------------------
 * This updates the REGISTRY, not the installed components. Refreshing
 * vendor/koc-registry/dialog.json does not change src/components/ui/dialog.tsx.
 * To take a component's update you still run:
 *
 *     npm run koc:add -- @koc/dialog
 *
 * and read the diff, because that overwrites the file including any local edits.
 * That is the shadcn model, not a limitation of vendoring — the same is true of
 * installing straight from GitHub.
 *
 * Source resolution: a local checkout via `--from` (read with `git show <tag>:`,
 * so the tag is honoured rather than whatever is in the working tree), otherwise
 * the GitHub Contents API with KOC_REGISTRY_TOKEN.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "vendor", "koc-registry");
const REPO = "SaudKWT/koc-design-system";
const REGISTRY_PATH = "apps/docs/public/r";

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith("--"));
const fromIdx = args.indexOf("--from");
const from = fromIdx === -1 ? null : args[fromIdx + 1];

if (!tag) {
  console.error("usage: npm run koc:sync -- <tag> [--from <path to design system>]");
  process.exit(1);
}

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });

async function fromLocal(path) {
  // `git show <tag>:<path>` rather than reading the working tree, so an
  // uncommitted experiment in the design system can never leak into a handoff.
  const listing = git(path, "ls-tree", "--name-only", `${tag}:${REGISTRY_PATH}`)
    .split("\n")
    .filter((f) => f.endsWith(".json"));
  if (!listing.length) throw new Error(`no registry files at ${tag}:${REGISTRY_PATH}`);
  return listing.map((name) => ({
    name,
    content: git(path, "show", `${tag}:${REGISTRY_PATH}/${name}`),
  }));
}

async function fromGitHub() {
  const token = process.env.KOC_REGISTRY_TOKEN;
  if (!token) throw new Error("KOC_REGISTRY_TOKEN is not set, and no --from path was given");
  const api = `https://api.github.com/repos/${REPO}/contents/${REGISTRY_PATH}?ref=${tag}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const res = await fetch(api, { headers });
  if (!res.ok) throw new Error(`${api}: ${res.status} ${res.statusText}`);
  const entries = (await res.json()).filter((e) => e.name.endsWith(".json"));
  return Promise.all(
    entries.map(async (e) => {
      const r = await fetch(e.url, { headers: { ...headers, Accept: "application/vnd.github.raw" } });
      if (!r.ok) throw new Error(`${e.name}: ${r.status}`);
      return { name: e.name, content: await r.text() };
    }),
  );
}

const files = from ? await fromLocal(from) : await fromGitHub();

// Replace wholesale rather than merge: an item deleted upstream must disappear
// here too, or the vendored copy quietly keeps offering something that no longer
// exists in the system.
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const f of files) await writeFile(join(OUT, f.name), f.content);

await writeFile(
  join(OUT, "VERSION"),
  `${tag}\nsource: ${from ? `local ${from}` : `github ${REPO}`}\nitems: ${files.length}\n`,
);

console.log(`vendored ${files.length} items at ${tag}`);
console.log(`  ${OUT}`);
console.log("\nThis updated the registry, not the installed components.");
console.log("To take an update, re-add the component and read the diff:");
console.log("  npm run koc:add -- @koc/theme");

const stale = (await readdir(OUT)).filter((f) => f.endsWith(".json")).length;
if (stale !== files.length) console.warn(`warning: wrote ${files.length} but ${stale} on disk`);
