import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { ADMIN_PAGE } from "../src/admin-page.ts";

test("admin inline script parses as valid JavaScript", () => {
  const match = ADMIN_PAGE.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match, "ADMIN_PAGE must contain an inline script");
  try {
    new vm.Script(match[1], { filename: "admin-inline.js" });
  } catch (error) {
    const lines = match[1].split("\n");
    console.error(lines.slice(34, 44).map((line, index) => `${index + 35}: ${line}`).join("\n"));
    throw error;
  }
});
