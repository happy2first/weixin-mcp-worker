import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PAGE } from "../src/admin-page.ts";

test("admin inline script parses as valid JavaScript", () => {
  const match = ADMIN_PAGE.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match, "ADMIN_PAGE must contain an inline script");
  assert.doesNotThrow(() => new Function(match[1]), "admin inline script must parse");
});
