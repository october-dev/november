import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("reference firmware host simulation", () => {
  it("compiles with gcc and passes the protective-deadline checks", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "november-fw-"));
    try {
      const binary = path.join(directory, "protect-test");
      execFileSync(
        "gcc",
        [
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-o",
          binary,
          "firmware/reference/protect.c",
          "firmware/reference/test_protect.c",
        ],
        { cwd: path.resolve(import.meta.dirname, "../../..") },
      );
      const result = execFileSync(binary, { encoding: "utf8" });
      expect(result).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
