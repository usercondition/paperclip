import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyManagedPayloadVersions, readManagedPayloadIdentity } from "./prepare-managed-payload-versions.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = process.argv[2];
if (!outputDir) {
  process.stderr.write("Usage: node scripts/pack-managed-payload.mjs <output-dir>\n");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? "null"}`);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function workspaceClosure() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts", "release-package-manifest.json"), "utf8"));
  const byName = new Map(manifest.map((entry) => [entry.name, entry]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular workspace dependency while packing ${name}.`);
    const entry = byName.get(name);
    if (!entry) throw new Error(`Missing release package ${name}.`);
    visiting.add(name);
    const packageJson = JSON.parse(readFileSync(join(repoRoot, entry.dir, "package.json"), "utf8"));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependencyName of Object.keys(packageJson[section] ?? {})) {
        if (dependencyName.startsWith("@paperclipai/")) visit(dependencyName);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push({ ...entry, packageJson });
  };
  visit("@paperclipai/server");
  return ordered;
}

function readPackedManifest(tarball) {
  const json = execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
  return JSON.parse(json);
}

function removeUntrackedSkills() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts", "release-package-manifest.json"), "utf8"));
  for (const entry of manifest) {
    const packageJsonPath = join(repoRoot, entry.dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!Array.isArray(packageJson.files) || !packageJson.files.includes("skills")) continue;
    const destination = join(repoRoot, entry.dir, "skills");
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", destination], { cwd: repoRoot, stdio: "ignore" });
    if (tracked.status !== 0) rmSync(destination, { recursive: true, force: true });
  }
}

const commit = git(["rev-parse", "HEAD"]);
const identity = readManagedPayloadIdentity();
mkdirSync(outputDir, { recursive: true });
const stagingRoot = join(outputDir, "staging");
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

let failed = false;
try {
  applyManagedPayloadVersions();
  const buildEnv = { PAPERCLIP_BUILD_COMMIT: commit };
  run("bash", ["scripts/build-npm.sh", "--skip-checks", "--skip-typecheck"], { env: buildEnv });
  run("corepack", ["pnpm", "-r", "--filter", "@paperclipai/server...", "--if-present", "run", "build"], { env: buildEnv });
  run(process.execPath, ["scripts/stage-release-skills.mjs"]);
  run("bash", ["scripts/prepare-server-ui-dist.sh"], { env: { PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" } });

  const packages = workspaceClosure();
  for (const [index, workspacePackage] of packages.entries()) {
    const packageDir = join(repoRoot, workspacePackage.dir);
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const bundled = packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? [];
    if (bundled.length > 0) {
      const stagedPackage = join(stagingRoot, `workspace-package-${index}`);
      run(process.execPath, ["scripts/prepare-bundled-package.mjs", packageDir, stagedPackage]);
      run("npm", ["pack", stagedPackage, "--ignore-scripts", "--pack-destination", outputDir]);
    } else {
      run("corepack", ["pnpm", "--dir", workspacePackage.dir, "pack", "--pack-destination", outputDir], {
        env: { PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" },
      });
    }
  }
  run("npm", ["pack", "--pack-destination", outputDir], { cwd: join(repoRoot, "cli") });

  const tarballs = readdirSync(outputDir).filter((entry) => entry.endsWith(".tgz")).sort();
  if (tarballs.length !== packages.length + 1) {
    throw new Error(`Expected ${packages.length + 1} tarballs and found ${tarballs.length}.`);
  }
  const manifests = tarballs.map((name) => ({ name, manifest: readPackedManifest(join(outputDir, name)) }));
  const wrongVersion = manifests.filter((entry) => entry.manifest.version !== identity.version);
  if (wrongVersion.length > 0) {
    throw new Error(`Packed versions diverged: ${wrongVersion.map((entry) => `${entry.manifest.name}@${entry.manifest.version}`).join(", ")}`);
  }
  const pluginSdk = manifests.find((entry) => entry.manifest.name === "@paperclipai/plugin-sdk");
  const server = manifests.find((entry) => entry.manifest.name === "@paperclipai/server");
  const cli = manifests.find((entry) => entry.manifest.name === "paperclipai");
  if (!pluginSdk || !server || !cli) throw new Error("The packed set is missing the CLI, server, or plugin-sdk.");
  if (server.manifest.dependencies?.["@paperclipai/plugin-sdk"] !== identity.version) {
    throw new Error(`Server depends on plugin-sdk@${server.manifest.dependencies?.["@paperclipai/plugin-sdk"] ?? "missing"}.`);
  }
  const tarballHas = (tarball, member) => {
    const result = spawnSync("tar", ["-tzf", tarball, member], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return result.status === 0 && result.stdout.includes(member);
  };
  const hermes = manifests.find((entry) => entry.manifest.name === "@paperclipai/hermes-paperclip-adapter");
  if (hermes) {
    const hermesTarball = join(outputDir, hermes.name);
    if (!tarballHas(hermesTarball, "package/skills/paperclip-task-bridge/SKILL.md")) {
      throw new Error("Hermes package is missing its own paperclip-task-bridge skill.");
    }
    if (tarballHas(hermesTarball, "package/skills/suggestion-box/SKILL.md")) {
      throw new Error("Hermes package was overwritten with the repo skills tree.");
    }
  }
  if (!tarballHas(join(outputDir, server.name), "package/skills/paperclip/SKILL.md")) {
    throw new Error("Server package is missing the staged repo skills tree.");
  }
  const sums = manifests.map((entry) => {
    const bytes = readFileSync(join(outputDir, entry.name));
    return `${createHash("sha256").update(bytes).digest("hex")}  ${entry.name}`;
  });
  writeFileSync(join(outputDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  writeFileSync(join(outputDir, "build-identity.json"), `${JSON.stringify({
    commit,
    version: identity.version,
    rollbackVersion: identity.rollbackVersion,
    minimumNode: identity.minimumNode,
    pluginSdk: pluginSdk.manifest.version,
    serverPluginSdkDependency: server.manifest.dependencies["@paperclipai/plugin-sdk"],
  }, null, 2)}\n`);
  process.stdout.write(`packed ${identity.version} at ${commit}\n`);
} catch (error) {
  failed = true;
  throw error;
} finally {
  const restore = spawnSync("git", ["restore", "."], { cwd: repoRoot, stdio: "inherit" });
  rmSync(join(repoRoot, "cli", "package.dev.json"), { force: true });
  rmSync(join(repoRoot, "server", "ui-dist"), { recursive: true, force: true });
  removeUntrackedSkills();
  rmSync(stagingRoot, { recursive: true, force: true });
  if (restore.status !== 0) {
    process.stderr.write("git restore failed. Inspect the worktree before packing again.\n");
    process.exitCode = 1;
  }
  if (failed) process.exitCode = 1;
}
