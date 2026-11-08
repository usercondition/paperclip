import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

describe("managed repair control", () => {
  it("passes the shared adversarial suite", () => {
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--test",
        fileURLToPath(new URL("./managed-repair-control.suite.ts", import.meta.url)),
      ],
      { stdio: "pipe" },
    );
    expect(true).toBe(true);
  });
});
