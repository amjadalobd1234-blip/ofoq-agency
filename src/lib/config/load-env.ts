import fs from "node:fs";
import path from "node:path";

/**
 * Minimal, dependency-free `.env` loader.
 *
 * Next.js loads `.env` for the web app, but CLI scripts (`npm run db:migrate`,
 * `npm run db:seed`, cron jobs) run outside the bundler, so they need the same
 * values. Loading is idempotent and NEVER overrides variables that already
 * exist in `process.env` — real environment variables always win over files.
 */
let loaded = false;

const CANDIDATE_FILES = [".env.local", ".env"];

export function loadEnvFiles(rootDir: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  for (const file of CANDIDATE_FILES) {
    const filePath = path.join(rootDir, file);
    if (!fs.existsSync(filePath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of parseEnv(content)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function parseEnv(content: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    // Strip a single layer of matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    entries.push([key, value]);
  }
  return entries;
}
