import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/chatgpt-file-bridge.ts", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("Worker entrypoint routes through the ChatGPT file bridge", () => {
  assert.match(wrangler, /"main":\s*"src\/chatgpt-file-bridge\.ts"/);
  assert.match(source, /"openai\/fileParams"/);
  assert.match(source, /\[FILE_PARAM_META_KEY\]: \[FILE_PARAM_NAME\]/);
  assert.match(source, /download_url/);
  assert.match(source, /file_id/);
});

test("file bridge converts a ChatGPT attachment into the existing base64 media path", () => {
  assert.match(source, /url\.protocol !== "https:"/);
  assert.match(source, /await fetch\(url, \{ redirect: "follow" \}\)/);
  assert.match(source, /MAX_MEDIA_BYTES/);
  assert.match(source, /args\.dataBase64 = Buffer\.from\(downloaded\.bytes\)\.toString\("base64"\)/);
  assert.match(source, /file、dataBase64 和 sourceMediaRef 必须且只能提供一个/);
});
