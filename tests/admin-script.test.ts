import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ADMIN_PAGE } from "../src/admin-page.ts";

test("admin inline script parses as valid JavaScript", () => {
  const match = ADMIN_PAGE.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match, "ADMIN_PAGE must contain an inline script");
  const path = "/tmp/admin-inline.js";
  writeFileSync(path, match[1], "utf8");
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout || "admin inline script failed syntax check");
  } finally {
    unlinkSync(path);
  }
});
