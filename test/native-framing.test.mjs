import test from "node:test";
import assert from "node:assert/strict";
import {
  NativeMessageDecoder,
  encodeNativeMessage
} from "../companion/native-framing.mjs";

test("round trips native messages split across arbitrary chunks", () => {
  const decoder = new NativeMessageDecoder();
  const first = encodeNativeMessage({ type: "first", value: 1 });
  const second = encodeNativeMessage({ type: "second", value: 2 });
  const stream = Buffer.concat([first, second]);

  assert.deepEqual(decoder.push(stream.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(stream.subarray(3, 11)), []);
  assert.deepEqual(decoder.push(stream.subarray(11)), [
    { type: "first", value: 1 },
    { type: "second", value: 2 }
  ]);
});
