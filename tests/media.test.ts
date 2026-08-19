import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/media-v051.ts", import.meta.url), "utf8");

test("media implementation uses AES-128-ECB with a zero-length IV buffer for Workers compatibility", () => {
  assert.match(source, /const ECB_NO_IV = Buffer\.alloc\(0\)/);
  assert.match(source, /createDecipheriv\("aes-128-ecb",\s*Buffer\.from\(key\),\s*ECB_NO_IV\)/);
  assert.match(source, /createCipheriv\("aes-128-ecb",\s*Buffer\.from\(key\),\s*ECB_NO_IV\)/);
  assert.doesNotMatch(source, /create(?:De)?Cipheriv\("aes-128-ecb",[^\n]*null\)/);
  assert.doesNotMatch(source, /aes-128-cbc/i);
});

test("media implementation accepts all observed AES-128 key encodings", () => {
  assert.match(source, /\^\[0-9a-fA-F\]\{32\}\$/);
  assert.match(source, /decoded\.length === 16/);
  assert.match(source, /decoded\.length === 32/);
  assert.match(source, /Buffer\.from\(ascii, "hex"\)/);
});

test("image media has fallback candidates and validates decoded image signatures", () => {
  assert.match(source, /label: "media"/);
  assert.match(source, /label: "thumb_media"/);
  assert.match(source, /image\.url\?\.trim\(\)/);
  assert.match(source, /detectImageMime\(downloaded\.bytes\)/);
  assert.match(source, /AES-128-ECB，不使用 IV/);
});
