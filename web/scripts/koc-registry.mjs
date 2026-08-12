#!/usr/bin/env node
/**
 * The @koc registry, served from vendor/ over loopback.
 *
 * WHY THIS EXISTS
 * ---------------
 * The design system is a private GitHub repo, and `components.json` originally
 * pointed at the GitHub Contents API with a personal token. That is fine on a
 * machine with GitHub access and a token that has not expired; it is a poor bet
 * for a KOC build agent, where api.github.com may not resolve at all.
 *
 * The obvious fix — point the CLI at the files on disk — does not work. shadcn
 * resolves a relative registry path against https://ui.shadcn.com/r/, and a
 * file:// URL returns "not implemented... yet...". Verified against the CLI on
 * 2026-08-12, both forms.
 *
 * So the vendored files are served over 127.0.0.1 for the length of one command.
 * That keeps the real CLI in the loop, which matters more than it sounds:
 * registryDependencies resolution, the import rewriting into @/ aliases, and the
 * overwrite behaviour all stay exactly as shadcn documents them. Reimplementing
 * those to read JSON off disk would be a fork of the install model the whole
 * design system is built on.
 *
 *   node scripts/koc-registry.mjs serve            keep it up (ctrl-c to stop)
 *   node scripts/koc-registry.mjs add @koc/dialog  serve, add, stop
 *
 * Nothing here talks to the network.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "..", "vendor", "koc-registry");
const PORT = Number(process.env.KOC_REGISTRY_PORT || 4183);

async function serve() {
  const files = new Set(await readdir(REGISTRY));
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url || "").split("?")[0].replace(/^\//, ""));
    if (!files.has(name) || name.includes("..") || !name.endsWith(".json")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `no such registry item: ${name}` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(await readFile(join(REGISTRY, name)));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  return { server, count: files.size };
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "serve") {
  const { count } = await serve();
  const version = await readFile(join(REGISTRY, "VERSION"), "utf8").catch(() => "unknown\n");
  console.log(`@koc registry (${version.trim()}) — ${count} items on http://127.0.0.1:${PORT}`);
  console.log("components.json already points here. Ctrl-C to stop.");
} else if (mode === "add") {
  if (!rest.length) {
    console.error("usage: node scripts/koc-registry.mjs add @koc/<item> [@koc/<item>…]");
    process.exit(1);
  }
  const { server } = await serve();
  // `npx shadcn add` writes into this project using its own components.json,
  // which already names the loopback URL — nothing is rewritten here.
  const child = spawn("npx", ["--yes", "shadcn@latest", "add", ...rest], {
    stdio: "inherit",
    cwd: join(HERE, ".."),
  });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 0);
  });
} else {
  console.error("usage: node scripts/koc-registry.mjs <serve|add> [items…]");
  process.exit(1);
}
