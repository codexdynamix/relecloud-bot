import assert from "node:assert/strict";
import test from "node:test";
import { parseReferrerId } from "./referral.js";

test("accepts a valid different Telegram user ID", () => {
  assert.equal(parseReferrerId("123456789", 987654321), 123456789);
});

test("rejects self-referrals and malformed IDs", () => {
  assert.equal(parseReferrerId("123", 123), null);
  assert.equal(parseReferrerId("-123", 456), null);
  assert.equal(parseReferrerId("not-a-user", 456), null);
});

test("rejects IDs outside JavaScript's safe integer range", () => {
  assert.equal(parseReferrerId("9007199254740992", 456), null);
});
