import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DataStore } from "./db.js";

test("activates a Stars purchase and records one direct affiliate commission", async () => {
  const store = createStore();
  try {
    await store.registerUser(1001, "affiliate", null);
    const membership = await store.createOrGetPendingPurchase(1001, 250);
    const firstPayment = await store.completePayment(
      membership.id,
      1001,
      "membership-charge",
      "XTR",
      250,
      14,
    );
    assert.equal(firstPayment.status, "activated");
    assert.equal(await store.hasActiveMembership(1001), true);

    await store.registerUser(2002, "buyer", 1001);
    const referral = await store.createOrGetPendingPurchase(2002, 250);
    assert.equal(
      await store.validatePreCheckout(referral.id, 2002, "XTR", 250),
      true,
    );
    assert.equal(
      await store.validatePreCheckout(referral.id, 2002, "USD", 250),
      false,
    );

    const payment = await store.completePayment(
      referral.id,
      2002,
      "referral-charge",
      "XTR",
      250,
      0,
    );
    assert.equal(payment.status, "activated");
    assert.equal(payment.referrerId, 1001);
    assert.ok(payment.commissionId);

    const duplicate = await store.completePayment(
      referral.id,
      2002,
      "referral-charge",
      "XTR",
      250,
      0,
    );
    assert.equal(duplicate.status, "duplicate");

    assert.deepEqual(await store.getReferralSummary(1001), {
      paidReferralCount: 1,
      pendingCents: 100,
      paidCents: 0,
    });
    assert.equal(
      await store.markCommissionPaid(payment.commissionId!, 1001, "TX:1234"),
      true,
    );
    assert.deepEqual(await store.getReferralSummary(1001), {
      paidReferralCount: 1,
      pendingCents: 0,
      paidCents: 100,
    });

    await store.submitPanelApplication(2002, "I would like to discuss livestream topics.");
    const applications = await store.listPanelApplications();
    assert.equal(applications.length, 1);
    assert.equal(
      await store.decidePanelApplication(applications[0].id, 1001, "selected"),
      "2002",
    );
    assert.equal((await store.listPanelApplications()).length, 0);
  } finally {
    store.close();
  }
});

test("refund revokes membership and cancels an unpaid affiliate commission", async () => {
  const store = createStore();
  try {
    await store.registerUser(3001, "referrer", null);
    const referrerPurchase = await store.createOrGetPendingPurchase(3001, 250);
    await store.completePayment(
      referrerPurchase.id,
      3001,
      "referrer-charge",
      "XTR",
      250,
      14,
    );

    await store.registerUser(3002, "referral", 3001);
    const purchase = await store.createOrGetPendingPurchase(3002, 250);
    await store.completePayment(
      purchase.id,
      3002,
      "referral-refund-charge",
      "XTR",
      250,
      14,
    );

    assert.equal(await store.hasActiveMembership(3002), true);
    assert.deepEqual(await store.refundPayment("referral-refund-charge"), {
      userId: 3002,
      revokeAccess: true,
      commissionAlreadyPaid: false,
    });
    assert.equal(await store.hasActiveMembership(3002), false);
    assert.deepEqual(await store.getReferralSummary(3001), {
      paidReferralCount: 0,
      pendingCents: 0,
      paidCents: 0,
    });
    assert.deepEqual(await store.refundPayment("referral-refund-charge"), {
      userId: 3002,
      revokeAccess: false,
      commissionAlreadyPaid: false,
    });
  } finally {
    store.close();
  }
});

function createStore(): DataStore {
  const store = new DataStore(new DatabaseSync(":memory:"));
  store.initialize();
  return store;
}
