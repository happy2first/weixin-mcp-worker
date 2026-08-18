import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETENTION_LIMIT_BYTES,
  SAFE_PROJECT_HISTORY_BUDGET_BYTES,
  SEND_CHUNK_SIZE,
  normalizeHttpsUrl,
  normalizeProfileId,
  projectBudgetWithinLimit,
  retentionTargetBytes,
  splitText,
} from "../src/core.ts";

test("splitText respects safe Weixin chunk size", () => {
  const input = "甲".repeat(SEND_CHUNK_SIZE * 2 + 17);
  const chunks = splitText(input);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= SEND_CHUNK_SIZE));
  assert.equal(chunks.join(""), input);
});

test("normalizeProfileId accepts aliases and rejects unsafe ids", () => {
  assert.equal(normalizeProfileId(" Wife_1 "), "wife_1");
  assert.throws(() => normalizeProfileId("../wife"));
});

test("normalizeHttpsUrl requires TLS", () => {
  assert.equal(normalizeHttpsUrl("ilinkai.weixin.qq.com"), "https://ilinkai.weixin.qq.com");
  assert.throws(() => normalizeHttpsUrl("http://example.com"));
});

test("retention target and project budget remain conservative", () => {
  assert.equal(retentionTargetBytes(700), 630);
  assert.equal(MAX_RETENTION_LIMIT_BYTES, 700 * 1024 * 1024);
  assert.equal(projectBudgetWithinLimit([700 * 1024 * 1024, 700 * 1024 * 1024]), true);
  assert.equal(projectBudgetWithinLimit([SAFE_PROJECT_HISTORY_BUDGET_BYTES, 1]), false);
});
