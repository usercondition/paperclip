import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts", "release-package-manifest.json"), "utf8"));

if (!existsSync(skillsRoot)) {
  throw new Error(`Release skills directory is missing at ${skillsRoot}.`);
}

const staged = [];
for (const entry of manifest) {
  const packageJsonPath = join(repoRoot, entry.dir, "package.json");
  if (!existsSync(packageJsonPath)) continue;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes("skills")) continue;
  const destination = join(repoRoot, entry.dir, "skills");
  rmSync(destination, { recursive: true, force: true });
  cpSync(skillsRoot, destination, { recursive: true });
  staged.push(destination);
}

process.stdout.write(`${staged.length}\n`);
