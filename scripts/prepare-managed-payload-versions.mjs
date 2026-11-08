import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setVersion } from "./release-package-map.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function readManagedPayloadIdentity(root = repoRoot) {
  const identity = JSON.parse(readFileSync(join(root, "scripts", "managed-payload-version.json"), "utf8"));
  if (typeof identity.version !== "string" || !VERSION_PATTERN.test(identity.version)) {
    throw new Error(`Invalid managed payload version '${identity.version ?? ""}'.`);
  }
  if (typeof identity.rollbackVersion !== "string" || !VERSION_PATTERN.test(identity.rollbackVersion)) {
    throw new Error(`Invalid rollback version '${identity.rollbackVersion ?? ""}'.`);
  }
  if (typeof identity.minimumNode !== "string" || !/^\d+\.\d+\.\d+$/.test(identity.minimumNode)) {
    throw new Error(`Invalid minimum Node '${identity.minimumNode ?? ""}'.`);
  }
  return identity;
}

export function applyManagedPayloadVersions(root = repoRoot) {
  const identity = readManagedPayloadIdentity(root);
  setVersion(identity.version);
  return identity;
}

if (process.argv[1]?.endsWith("prepare-managed-payload-versions.mjs")) {
  const identity = applyManagedPayloadVersions();
  process.stdout.write(`${identity.version}\n`);
}
