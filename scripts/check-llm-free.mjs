#!/usr/bin/env node
/**
 * LLM-Free Runtime guard (spec §1.4 R-LLM-01..03, M15a).
 *
 * Fails if any runtime code path (game Worker, kernel, scenario DSL, world
 * data) could reach an LLM: AI bindings, LLM SDKs (direct or transitive),
 * inference endpoints, LLM secrets, or network access from the kernel.
 * Evolution code (apps/evolution, future) is the only place allowed to use LLMs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const RUNTIME_APPS = ["apps/game"]; // add apps/chronicle when it exists
const RUNTIME_DIRS = [...RUNTIME_APPS.map((a) => `${a}/src`), "packages/kernel/src", "packages/scenario-dsl/src", "world"];
const NO_NETWORK_DIRS = ["packages/kernel/src", "packages/scenario-dsl/src", "world"];

const FORBIDDEN_PACKAGES = [
  /^openai$/, /^@openai\//, /^@anthropic-ai\//, /^anthropic$/, /^ai$/, /^@ai-sdk\//, /^langchain/, /^@langchain\//,
  /^cohere/, /^@mistralai\//, /^@google\/generative-ai$/, /^@google\/genai$/, /^ollama$/, /^workers-ai-provider$/,
  /^@cloudflare\/ai$/, /^replicate$/, /^groq-sdk$/, /^together-ai$/, /^llamaindex$/,
];
const FORBIDDEN_SOURCE = [
  [/api\.openai\.com/, "OpenAI endpoint"],
  [/api\.anthropic\.com/, "Anthropic endpoint"],
  [/generativelanguage\.googleapis\.com/, "Gemini endpoint"],
  [/gateway\.ai\.cloudflare\.com/, "AI Gateway endpoint"],
  [/\benv\.AI\b/, "AI binding usage"],
  [/\b(OPENAI|ANTHROPIC|GEMINI|LLM|CLAUDE)_?API_?KEY\b/, "LLM API key reference"],
  [/\bEVOLUTION\b\s*[:.]/, "binding to the Evolution pipeline"],
];
const FORBIDDEN_WRANGLER = [
  [/"ai"\s*:/, "AI binding"],
  [/"workflows"\s*:/, "Workflow binding (Evolution only)"],
  [/"services"\s*:[^\]]*evolution/s, "service binding to evolution"],
  [/(OPENAI|ANTHROPIC|GEMINI|LLM)_/, "LLM-related variable"],
];

const errors = [];
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs|json|jsonc)$/.test(name)) out.push(p);
  }
  return out;
};

// 1. Source scan
for (const d of RUNTIME_DIRS) {
  for (const file of walk(join(root, d))) {
    const src = readFileSync(file, "utf8");
    const rel = relative(root, file);
    for (const [re, what] of FORBIDDEN_SOURCE) if (re.test(src)) errors.push(`${rel}: ${what}`);
    for (const m of src.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (FORBIDDEN_PACKAGES.some((re) => re.test(pkg))) errors.push(`${rel}: imports LLM package ${pkg}`);
    }
    if (NO_NETWORK_DIRS.some((nd) => rel.startsWith(nd)) && /\bfetch\s*\(|WebSocket|XMLHttpRequest|connect\(/.test(src))
      errors.push(`${rel}: network access is not allowed in the kernel/DSL/world`);
  }
}

// 2. Wrangler configs of runtime apps
for (const app of RUNTIME_APPS) {
  for (const f of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    let text;
    try {
      text = readFileSync(join(root, app, f), "utf8");
    } catch {
      continue;
    }
    const noComments = text.replace(/^\s*\/\/.*$/gm, "");
    for (const [re, what] of FORBIDDEN_WRANGLER) if (re.test(noComments)) errors.push(`${app}/${f}: ${what}`);
  }
}

// 3. Dependency tree (direct + transitive) of runtime workspaces via package-lock
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const pkgs = lock.packages ?? {};
const resolveDep = (fromPath, name) => {
  let base = fromPath;
  while (true) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (pkgs[candidate]) return candidate;
    if (!base) return undefined;
    const idx = base.lastIndexOf("/node_modules/");
    base = idx === -1 ? "" : base.slice(0, idx);
  }
};
const seen = new Set();
const visit = (path, chain) => {
  if (seen.has(path)) return;
  seen.add(path);
  const meta = pkgs[path];
  if (!meta) return;
  const name = path.split("node_modules/").pop();
  if (FORBIDDEN_PACKAGES.some((re) => re.test(name))) errors.push(`dependency ${name} reachable from runtime via ${chain.join(" > ")}`);
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
    const p = resolveDep(path, dep);
    if (p) visit(p, [...chain, dep]);
  }
};
for (const ws of [...RUNTIME_APPS, "packages/kernel", "packages/scenario-dsl", "world"]) visit(ws, [ws]);

if (errors.length) {
  console.error("LLM-Free Runtime check FAILED:");
  for (const e of errors) console.error("  -", e);
  process.exit(1);
}
console.log(`LLM-Free Runtime check passed (${seen.size} runtime packages scanned, 0 LLM paths).`);
