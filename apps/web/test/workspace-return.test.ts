import assert from "node:assert/strict";
import { test } from "node:test";
import { signInReturnPath } from "../lib/workspace-return";

const origin = "https://tideline.example";

test("sign-in preserves the team session and filters and removes Clerk and Next transport parameters", () => {
  const path = "/workspace/polaris/sessions/session-id?agent=codex&sort=recent#message-4";
  assert.equal(signInReturnPath(origin + path, origin), path);
  assert.equal(signInReturnPath(path.replace("#", "&__clerk_handshake=trace&_rsc=trace#"), origin), path);
  assert.equal(signInReturnPath("/invite/example", origin), "/invite/example");
});

test("sign-in rejects external, recursive, and ambiguous return URLs", () => {
  for (const value of ["//another.example/workspace/team", "https://another.example/workspace/team", "javascript:alert(1)",
    "https://tideline.example//another.example/", "https://user@tideline.example/workspace/team", "/sign-in/continue", "/sign-up"]) {
    assert.equal(signInReturnPath(value, origin), undefined);
  }
});
