import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { DataStore } from "./db.js";
import { startMiniAppServer } from "./miniapp.js";

const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const config = loadConfig({
  BOT_TOKEN: botToken,
  ADMIN_USER_ID: "98765",
  MEMBERSHIP_CHAT_ID: "-1001234567890",
  BOT_USERNAME: "relecloutbot",
  MEMBERSHIP_PRICE_STARS: "250",
  COMMISSION_HOLD_DAYS: "14",
});
const store = new DataStore(new DatabaseSync(":memory:"));
store.initialize();
const bot = new Bot(botToken);
config.miniAppPort = 0;
const server = await startMiniAppServer(bot, config, store);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Mini App test server did not bind to a TCP port");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  store.close();
});

function createInitData(userId: number, startParameter = "home"): string {
  const fields = new Map([
    ["auth_date", String(Math.floor(Date.now() / 1000))],
    ["start_param", startParameter],
    ["user", JSON.stringify({ id: userId, first_name: "Test" })],
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

test("serves the Mini App and a health endpoint", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Lifetime access/);
  assert.equal(page.headers.get("content-security-policy")?.includes("object-src 'none'"), true);
});

test("requires signed Telegram data and returns only the authenticated user's dashboard", async () => {
  const unauthorized = await fetch(`${baseUrl}/api/me`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/api/me`, {
    headers: { "X-Telegram-Init-Data": createInitData(12345) },
  });
  assert.equal(response.status, 200);
  const dashboard = await response.json() as {
    user: { id: number };
    membershipActive: boolean;
    referralLink: string | null;
    priceStars: number;
  };
  assert.equal(dashboard.user.id, 12345);
  assert.equal(dashboard.membershipActive, false);
  assert.equal(dashboard.referralLink, null);
  assert.equal(dashboard.priceStars, 250);
});

test("blocks member-only actions for an authenticated non-member", async () => {
  const initData = createInitData(54321);
  const access = await fetch(`${baseUrl}/api/access`, {
    method: "POST",
    headers: {
      "X-Telegram-Init-Data": initData,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(access.status, 403);

  const application = await fetch(`${baseUrl}/api/panel-application`, {
    method: "POST",
    headers: {
      "X-Telegram-Init-Data": initData,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ application: "I would like to join a panel discussion." }),
  });
  assert.equal(application.status, 403);
});

test("supports member actions and restricts host controls to the configured admin", async () => {
  const memberId = 77777;
  await store.registerUser(memberId, "member", null);
  const purchase = await store.createOrGetPendingPurchase(memberId, 250);
  await store.completePayment(
    purchase.id,
    memberId,
    "miniapp-test-charge",
    "XTR",
    250,
    14,
  );
  const memberInitData = createInitData(memberId);
  const dashboard = await fetch(`${baseUrl}/api/me`, {
    headers: { "X-Telegram-Init-Data": memberInitData },
  });
  const member = await dashboard.json() as {
    membershipActive: boolean;
    referralLink: string | null;
  };
  assert.equal(member.membershipActive, true);
  assert.match(member.referralLink ?? "", /startapp=ref_77777$/);

  const application = await fetch(`${baseUrl}/api/panel-application`, {
    method: "POST",
    headers: {
      "X-Telegram-Init-Data": memberInitData,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ application: "I would like to discuss science and creative problem solving." }),
  });
  assert.equal(application.status, 200);

  const deniedAdminView = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { "X-Telegram-Init-Data": memberInitData },
  });
  assert.equal(deniedAdminView.status, 403);

  const adminView = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { "X-Telegram-Init-Data": createInitData(98765) },
  });
  assert.equal(adminView.status, 200);
  const admin = await adminView.json() as {
    applications: Array<{ userId: string }>;
  };
  assert.equal(admin.applications.length, 1);
  assert.equal(admin.applications[0].userId, String(memberId));
});
