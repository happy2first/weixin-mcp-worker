import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { decodeAes128Key, decryptAesEcb, encryptAesEcb } from "../src/media-v051.ts";

const KEY_HEX = "00112233445566778899aabbccddeeff";
const KEY = Buffer.from(KEY_HEX, "hex");

test("decodeAes128Key accepts raw hex, base64(raw bytes), and base64(hex text)", () => {
  const rawHex = decodeAes128Key(KEY_HEX);
  const base64Raw = decodeAes128Key(KEY.toString("base64"));
  const base64HexText = decodeAes128Key(Buffer.from(KEY_HEX, "ascii").toString("base64"));

  assert.deepEqual(rawHex, KEY);
  assert.deepEqual(base64Raw, KEY);
  assert.deepEqual(base64HexText, KEY);
});

test("AES-128-ECB media round trip uses no IV", () => {
  const plaintext = Buffer.from("weixin-media-ecb-round-trip");
  const ciphertext = encryptAesEcb(plaintext, KEY);
  assert.notDeepEqual(Buffer.from(ciphertext), plaintext);
  const decrypted = decryptAesEcb(ciphertext, KEY);
  assert.deepEqual(Buffer.from(decrypted), plaintext);
});

test("AES-128 helpers reject non-128-bit keys", () => {
  assert.throws(() => encryptAesEcb(Buffer.from("x"), Buffer.alloc(15)), /16 bytes/);
  assert.throws(() => decryptAesEcb(Buffer.alloc(16), Buffer.alloc(15)), /16 bytes/);
});
