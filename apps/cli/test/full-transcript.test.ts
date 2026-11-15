import assert from "node:assert/strict";
import { test } from "node:test";
import { isRedactedTranscriptText } from "@tideline/contracts/transcripts";
import { prepareTranscriptRecord } from "../src/full-transcript";

test("raw archive records preserve supported embedded images and scrub secrets before upload", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3XcAAAAASUVORK5CYII=";
  const token = "ghp_" + "t".repeat(30);
  const input = {
    text: `Keep the emoji 🔍 but redact ${token}`,
    auth: { clientSecret: "short" },
    source: { type: "base64", media_type: "image/png", data: png },
    alternate: `DATA:image/png;BASE64,${png}`,
    unsupported: "data:application/pdf;base64,AAAA",
  };
  const { text, attachments, omitted } = prepareTranscriptRecord(Buffer.from(JSON.stringify(input)));
  const record = JSON.parse(text);
  assert.equal(isRedactedTranscriptText(input), false);
  assert.equal(isRedactedTranscriptText(record), true);
  assert.equal(record.text, "Keep the emoji 🔍 but redact [REDACTED TOKEN]");
  assert.equal(record.auth, "[REDACTED]");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].base64, png);
  assert.deepEqual(record.source, { tideline_attachment: attachments[0].digest, mime: "image/png" });
  assert.deepEqual(record.alternate, record.source);
  assert.equal(omitted, true);
  assert.match(record.unsupported.tideline_omitted, /Unsupported/u);
});
