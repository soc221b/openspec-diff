import assert from "node:assert/strict";
import test from "node:test";

import { getWelcomeMessage } from "../src/message.ts";

test("getWelcomeMessage returns the default message", () => {
  assert.equal(getWelcomeMessage(), "Hello from OpenSpec Diff");
});
