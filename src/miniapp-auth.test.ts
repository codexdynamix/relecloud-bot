import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyMiniAppInitData } from "./miniapp-auth.js";

const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nowSeconds = 1_800_000_000;

function createInitData(
  user: Record<string, unknown> = { id: 12345, first_name: "Test", username: "test_user" },
  authDate = nowSeconds,
  startParameter = "home",
): string {
  const fields = new Map([
    ["auth_date", String(authDate)],
    ["start_param", startParameter],
    ["user", JSON.stringify(user)],
  ]);
  const dataCheckString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  fields.set("hash", hash);
  return new URLSearchParams([...fields.entries()]).toString();
}

test("verifies Telegram initialization data and exposes its start parameter", () => {
  const verified = verifyMiniAppInitData(
    createInitData(),
    botToken,
    nowSeconds,
  );
  assert.equal(verified.user.id, 12345);
  assert.equal(verified.user.username, "test_user");
  assert.equal(verified.startParameter, "home");
});

test("rejects modified or incorrectly signed initialization data", () => {
  const initData = createInitData().replace("Test", "Other");
  assert.throws(
    () => verifyMiniAppInitData(initData, botToken, nowSeconds),
    /signature is invalid/,
  );
});

test("rejects expired, future-dated, and malformed Telegram users", () => {
  assert.throws(
    () => verifyMiniAppInitData(createInitData(undefined, nowSeconds - 86_401), botToken, nowSeconds),
    /has expired/,
  );
  assert.throws(
    () => verifyMiniAppInitData(createInitData(undefined, nowSeconds + 31), botToken, nowSeconds),
    /has expired/,
  );
  assert.throws(
    () => verifyMiniAppInitData(createInitData({ id: "12345", first_name: "Test" }), botToken, nowSeconds),
    /user data is invalid/,
  );
});

test("rejects duplicate initialization fields", () => {
  assert.throws(
    () => verifyMiniAppInitData(`${createInitData()}&auth_date=${nowSeconds}`, botToken, nowSeconds),
    /duplicate fields/,
  );
});
