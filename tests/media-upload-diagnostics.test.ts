import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");

test("CDN upload diagnostics identify all failure stages", () => {
  assert.match(source, /fail\("getuploadurl"/);
  assert.match(source, /fail\("getuploadurl_response"/);
  assert.match(source, /fail\("cdn_upload_request"/);
  assert.match(source, /fail\("cdn_upload_response"/);
  assert.match(source, /fail\("cdn_upload_response_validation"/);
});

test("CDN HTTP failures include safe response details", () => {
  assert.match(source, /const bodyText = await response\.text/);
  assert.match(source, /xErrorMessage/);
  assert.match(source, /xRequestId/);
  assert.match(source, /xCosRequestId/);
  assert.match(source, /xNwsLogUuid/);
  assert.match(source, /uploadHost/);
  assert.match(source, /rawBytes/);
  assert.match(source, /encryptedBytes/);
});
