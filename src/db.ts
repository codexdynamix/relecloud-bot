import { randomUUID } from "node:crypto";
import {
  DatabaseSync,
  type SQLOutputValue,
} from "node:sqlite";

export interface Purchase {
  id: string;
  starsAmount: number;
}

export interface CompletedPayment {
  status: "activated" | "duplicate";
  userId: number;
  referrerId: number | null;
  commissionId: string | null;
}

export interface ReferralSummary {
  paidReferralCount: number;
  pendingCents: number;
  paidCents: number;
}

export interface PendingCommission {
  id: string;
  referrerId: string;
  username: string | null;
  amountCents: number;
  eligibleAfter: Date;
}

export interface PanelApplication {
  id: string;
  userId: string;
  username: string | null;
  application: string;
  createdAt: Date;
}

export class DataStore {
  constructor(private readonly database: DatabaseSync) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        referrer_id INTEGER REFERENCES users(telegram_id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        CHECK (referrer_id IS NULL OR referrer_id <> telegram_id)
      );

      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL REFERENCES users(telegram_id),
        referrer_id INTEGER REFERENCES users(telegram_id) ON DELETE SET NULL,
        stars_amount INTEGER NOT NULL CHECK (stars_amount > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'refunded')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        paid_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_purchase_per_user
        ON purchases(telegram_user_id) WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY,
        purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
        telegram_charge_id TEXT NOT NULL UNIQUE,
        currency TEXT NOT NULL CHECK (currency = 'XTR'),
        total_amount INTEGER NOT NULL CHECK (total_amount > 0),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS memberships (
        telegram_user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id),
        purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'refunded')),
        granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS commissions (
        id INTEGER PRIMARY KEY,
        purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
        referrer_id INTEGER NOT NULL REFERENCES users(telegram_id),
        amount_usd_cents INTEGER NOT NULL CHECK (amount_usd_cents > 0),
        payout_currency TEXT NOT NULL CHECK (payout_currency = 'USDT'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
        eligible_after INTEGER NOT NULL,
        paid_at INTEGER,
        payout_reference TEXT,
        payout_admin_id INTEGER REFERENCES users(telegram_id),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS panel_applications (
        id INTEGER PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL REFERENCES users(telegram_id),
        application TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('submitted', 'selected', 'declined')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        reviewed_at INTEGER,
        reviewed_by INTEGER REFERENCES users(telegram_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_open_panel_application_per_user
        ON panel_applications(telegram_user_id) WHERE status = 'submitted';
    `);
  }

  close(): void {
    this.database.close();
  }

  async registerUser(
    userId: number,
    username: string | undefined,
    referrerId: number | null,
  ): Promise<void> {
    this.database.prepare(`
      INSERT INTO users (telegram_id, username, referrer_id)
      VALUES (
        ?1,
        ?2,
        CASE
          WHEN ?3 IS NOT NULL
            AND ?3 <> ?1
            AND EXISTS (
              SELECT 1 FROM memberships
              WHERE telegram_user_id = ?3 AND status = 'active'
            )
          THEN ?3
          ELSE NULL
        END
      )
      ON CONFLICT (telegram_id)
      DO UPDATE SET username = excluded.username
    `).run(userId, username ?? null, referrerId);
  }

  async hasActiveMembership(userId: number): Promise<boolean> {
    return this.database.prepare(`
      SELECT 1 FROM memberships
      WHERE telegram_user_id = ? AND status = 'active'
    `).get(userId) !== undefined;
  }

  async createOrGetPendingPurchase(
    userId: number,
    starsAmount: number,
  ): Promise<Purchase> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare(
        "SELECT 1 FROM users WHERE telegram_id = ?",
      ).get(userId)) {
        throw new Error("User must start the bot before purchasing");
      }

      if (this.database.prepare(`
        SELECT 1 FROM memberships
        WHERE telegram_user_id = ? AND status = 'active'
      `).get(userId)) {
        throw new Error("User already has an active membership");
      }

      const existing = this.database.prepare(`
        SELECT id, stars_amount FROM purchases
        WHERE telegram_user_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(userId);
      if (existing) {
        this.database.exec("COMMIT");
        return {
          id: stringValue(existing.id),
          starsAmount: numberValue(existing.stars_amount),
        };
      }

      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO purchases (
          id, telegram_user_id, referrer_id, stars_amount, status
        )
        SELECT ?, telegram_id, referrer_id, ?, 'pending'
        FROM users WHERE telegram_id = ?
      `).run(id, starsAmount, userId);
      this.database.exec("COMMIT");
      return { id, starsAmount };
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  async validatePreCheckout(
    purchaseId: string,
    userId: number,
    currency: string,
    amount: number,
  ): Promise<boolean> {
    return this.database.prepare(`
      SELECT 1 FROM purchases
      WHERE id = ?
        AND telegram_user_id = ?
        AND stars_amount = ?
        AND status = 'pending'
        AND ? = 'XTR'
    `).get(purchaseId, userId, amount, currency) !== undefined;
  }

  async completePayment(
    purchaseId: string,
    userId: number,
    chargeId: string,
    currency: string,
    amount: number,
    holdDays: number,
  ): Promise<CompletedPayment> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existingPayment = this.database.prepare(`
        SELECT purchase_id FROM payments WHERE telegram_charge_id = ?
      `).get(chargeId);
      if (existingPayment) {
        if (stringValue(existingPayment.purchase_id) !== purchaseId) {
          throw new Error("Telegram charge ID was reused for a different purchase");
        }
        this.database.exec("COMMIT");
        return {
          status: "duplicate",
          userId,
          referrerId: null,
          commissionId: null,
        };
      }

      const row = this.database.prepare(`
        SELECT telegram_user_id, referrer_id, stars_amount, status
        FROM purchases WHERE id = ?
      `).get(purchaseId);
      if (
        !row ||
        numberValue(row.telegram_user_id) !== userId ||
        stringValue(row.status) !== "pending" ||
        numberValue(row.stars_amount) !== amount ||
        currency !== "XTR"
      ) {
        throw new Error("Successful payment did not match a pending purchase");
      }

      this.database.prepare(`
        INSERT INTO payments (purchase_id, telegram_charge_id, currency, total_amount)
        VALUES (?, ?, ?, ?)
      `).run(purchaseId, chargeId, currency, amount);
      this.database.prepare(`
        UPDATE purchases SET status = 'paid', paid_at = ?
        WHERE id = ?
      `).run(Date.now(), purchaseId);
      this.database.prepare(`
        INSERT INTO memberships (telegram_user_id, purchase_id, status)
        VALUES (?, ?, 'active')
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET purchase_id = excluded.purchase_id, status = 'active',
                      granted_at = ?
      `).run(userId, purchaseId, Date.now());

      const referrerId = row.referrer_id === null
        ? null
        : numberValue(row.referrer_id);
      let commissionId: string | null = null;
      if (referrerId !== null) {
        const commission = this.database.prepare(`
          INSERT INTO commissions (
            purchase_id, referrer_id, amount_usd_cents, payout_currency,
            status, eligible_after
          )
          SELECT ?, ?, 100, 'USDT', 'pending', ?
          WHERE EXISTS (
            SELECT 1 FROM memberships
            WHERE telegram_user_id = ? AND status = 'active'
          )
          ON CONFLICT (purchase_id) DO NOTHING
          RETURNING id
        `).get(
          purchaseId,
          referrerId,
          Date.now() + holdDays * 24 * 60 * 60 * 1000,
          referrerId,
        );
        commissionId = commission ? String(numberValue(commission.id)) : null;
      }

      this.database.exec("COMMIT");
      return { status: "activated", userId, referrerId, commissionId };
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  async refundPayment(
    chargeId: string,
  ): Promise<{
    userId: number;
    revokeAccess: boolean;
    commissionAlreadyPaid: boolean;
  } | null> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT p.telegram_user_id AS user_id, p.id AS purchase_id,
               EXISTS (
                 SELECT 1 FROM commissions c
                 WHERE c.purchase_id = p.id AND c.status = 'paid'
               ) AS commission_already_paid
        FROM purchases p
        JOIN payments pay ON pay.purchase_id = p.id
        WHERE pay.telegram_charge_id = ?
      `).get(chargeId);
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }

      const purchaseId = stringValue(row.purchase_id);
      const userId = numberValue(row.user_id);
      this.database.prepare(`
        UPDATE purchases SET status = 'refunded' WHERE id = ?
      `).run(purchaseId);
      const membership = this.database.prepare(`
        UPDATE memberships SET status = 'refunded'
        WHERE purchase_id = ? AND status = 'active'
      `).run(purchaseId);
      this.database.prepare(`
        UPDATE commissions SET status = 'cancelled'
        WHERE purchase_id = ? AND status = 'pending'
      `).run(purchaseId);

      this.database.exec("COMMIT");
      return {
        userId,
        revokeAccess: Number(membership.changes) === 1,
        commissionAlreadyPaid: numberValue(row.commission_already_paid) === 1,
      };
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  async getReferralSummary(userId: number): Promise<ReferralSummary> {
    const row = this.database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM commissions c
          JOIN purchases p ON p.id = c.purchase_id
          WHERE c.referrer_id = ?
            AND c.status IN ('pending', 'paid')
            AND p.status = 'paid'
        ) AS paid_referral_count,
        COALESCE(SUM(
          CASE WHEN status = 'pending' THEN amount_usd_cents ELSE 0 END
        ), 0) AS pending_cents,
        COALESCE(SUM(
          CASE WHEN status = 'paid' THEN amount_usd_cents ELSE 0 END
        ), 0) AS paid_cents
      FROM commissions WHERE referrer_id = ?
    `).get(userId, userId);
    if (!row) {
      throw new Error("Referral summary query returned no result");
    }
    return {
      paidReferralCount: numberValue(row.paid_referral_count),
      pendingCents: numberValue(row.pending_cents),
      paidCents: numberValue(row.paid_cents),
    };
  }

  async getLatestPanelApplication(
    userId: number,
  ): Promise<
    | (Pick<PanelApplication, "application" | "createdAt"> & {
        status: "submitted" | "selected" | "declined";
      })
    | null
  > {
    const row = this.database.prepare(`
      SELECT application, status, created_at
      FROM panel_applications
      WHERE telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(userId);
    if (!row) return null;

    const status = stringValue(row.status);
    if (status !== "submitted" && status !== "selected" && status !== "declined") {
      throw new Error("Unexpected panel application status in database");
    }

    return {
      application: stringValue(row.application),
      createdAt: new Date(numberValue(row.created_at)),
      status,
    };
  }

  async listPendingCommissions(limit = 20): Promise<PendingCommission[]> {
    return this.database.prepare(`
      SELECT c.id, c.referrer_id, u.username, c.amount_usd_cents,
             c.eligible_after
      FROM commissions c
      JOIN users u ON u.telegram_id = c.referrer_id
      WHERE c.status = 'pending'
      ORDER BY c.eligible_after ASC, c.id ASC
      LIMIT ?
    `).all(limit).map((row) => ({
      id: String(numberValue(row.id)),
      referrerId: String(numberValue(row.referrer_id)),
      username: nullableString(row.username),
      amountCents: numberValue(row.amount_usd_cents),
      eligibleAfter: new Date(numberValue(row.eligible_after)),
    }));
  }

  async markCommissionPaid(
    commissionId: string,
    adminId: number,
    reference: string,
  ): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE commissions
      SET status = 'paid', paid_at = ?, payout_reference = ?,
          payout_admin_id = ?
      WHERE id = ? AND status = 'pending' AND eligible_after <= ?
    `).run(
      Date.now(),
      reference,
      adminId,
      Number(commissionId),
      Date.now(),
    );
    return Number(result.changes) === 1;
  }

  async submitPanelApplication(userId: number, application: string): Promise<void> {
    this.database.prepare(`
      INSERT INTO panel_applications (telegram_user_id, application, status)
      VALUES (?, ?, 'submitted')
      ON CONFLICT (telegram_user_id) WHERE status = 'submitted'
      DO UPDATE SET application = excluded.application, created_at = ?
    `).run(userId, application, Date.now());
  }

  async listPanelApplications(limit = 20): Promise<PanelApplication[]> {
    return this.database.prepare(`
      SELECT a.id, a.telegram_user_id, u.username, a.application, a.created_at
      FROM panel_applications a
      JOIN users u ON u.telegram_id = a.telegram_user_id
      WHERE a.status = 'submitted'
      ORDER BY a.created_at ASC LIMIT ?
    `).all(limit).map((row) => ({
      id: String(numberValue(row.id)),
      userId: String(numberValue(row.telegram_user_id)),
      username: nullableString(row.username),
      application: stringValue(row.application),
      createdAt: new Date(numberValue(row.created_at)),
    }));
  }

  async decidePanelApplication(
    applicationId: string,
    adminId: number,
    decision: "selected" | "declined",
  ): Promise<string | null> {
    const result = this.database.prepare(`
      UPDATE panel_applications
      SET status = ?, reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'submitted'
    `).run(decision, Date.now(), adminId, Number(applicationId));
    if (Number(result.changes) !== 1) {
      return null;
    }

    const row = this.database.prepare(`
      SELECT telegram_user_id FROM panel_applications WHERE id = ?
    `).get(Number(applicationId));
    return row ? String(numberValue(row.telegram_user_id)) : null;
  }
}

function numberValue(value: SQLOutputValue | undefined): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("Expected a numeric value from the database");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database integer is outside the safe JavaScript range");
  }
  return parsed;
}

function stringValue(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Expected a text value from the database");
  }
  return value;
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value);
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch (error) {
    console.error("Database rollback failed", error);
  }
}
