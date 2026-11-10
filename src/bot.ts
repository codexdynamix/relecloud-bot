import { Bot, type Context } from "grammy";
import type { Config } from "./config.js";
import { DataStore } from "./db.js";
import { parseReferrerId } from "./referral.js";

export function createBot(config: Config, store: DataStore): Bot<Context> {
  const bot = new Bot(config.botToken);

  bot.command("start", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;

    const startParameter = ctx.match.trim();
    const referrerId = parseReferrerId(startParameter, ctx.from.id);
    await store.registerUser(ctx.from.id, ctx.from.username, referrerId);

    if (startParameter === "buy") {
      await sendMembershipInvoice(ctx, config, store);
      return;
    }
    if (startParameter === "affiliate") {
      await ctx.reply(
        "Affiliate tools: use /link to get your direct referral link and /referrals to check tracked commissions. An active membership is required for your link.",
      );
      return;
    }
    if (startParameter === "panel") {
      await ctx.reply(
        "Active members can apply to present on a panel by sending /applypanel followed by a 20–2000 character application. Hosts review applications separately.",
      );
      return;
    }

    if (await store.hasActiveMembership(ctx.from.id)) {
      await ctx.reply(
        "Welcome back. Use /access for your livestream access link, /link for your affiliate link, or /referrals to check commissions.",
      );
      return;
    }

    await ctx.reply(
      `Welcome! A lifetime membership gives you access to our exclusive livestreams. Membership is ${config.membershipPriceStars} Telegram Stars. Use /buy to purchase. After your membership is active, you can get your own affiliate link. Panel participation has a separate application and review process.`,
    );
  });

  bot.command("buy", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    await sendMembershipInvoice(ctx, config, store);
  });

  bot.on("pre_checkout_query", async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const valid = await store.validatePreCheckout(
      query.invoice_payload,
      query.from.id,
      query.currency,
      query.total_amount,
    );
    await ctx.answerPreCheckoutQuery(
      valid,
      valid ? undefined : "This invoice is no longer valid. Please contact support.",
    );
  });

  bot.on("message:successful_payment", async (ctx) => {
    if (!ctx.from) return;
    const payment = ctx.message.successful_payment;
    const result = await store.completePayment(
      payment.invoice_payload,
      ctx.from.id,
      payment.telegram_payment_charge_id,
      payment.currency,
      payment.total_amount,
      config.commissionHoldDays,
    );

    if (result.status === "duplicate") {
      console.warn("Ignored duplicate successful-payment update", {
        userId: ctx.from.id,
        chargeId: payment.telegram_payment_charge_id,
      });
      return;
    }

    await ctx.reply(
      "Payment confirmed. Your lifetime membership is active. Use /access to request entry to the livestream channel, /link for your affiliate link, and /applypanel to apply for a panel.",
    );
    await sendAccessLink(bot, config, ctx.from.id);

    if (result.referrerId !== null && result.commissionId !== null) {
      try {
        await bot.api.sendMessage(
          result.referrerId,
          "A direct referral completed a paid membership. Your $1 USDT commission is pending and can be paid after the configured hold period and admin verification.",
        );
      } catch (error) {
        console.error("Could not notify affiliate about pending commission", {
          referrerId: result.referrerId,
          commissionId: result.commissionId,
          error,
        });
      }
    }
  });

  bot.on("message:refunded_payment", async (ctx) => {
    const chargeId = ctx.message.refunded_payment.telegram_payment_charge_id;
    const refunded = await store.refundPayment(chargeId);
    if (!refunded) {
      console.error("Received a refund update for an unknown Stars payment", { chargeId });
      return;
    }

    if (refunded.commissionAlreadyPaid) {
      console.error("A refunded sale had an already-paid affiliate commission; manual reconciliation is required", {
        userId: refunded.userId,
        chargeId,
      });
    }

    if (refunded.revokeAccess) {
      try {
        await bot.api.banChatMember(config.membershipChatId, refunded.userId);
      } catch (error) {
        console.error("Could not revoke refunded member's channel access", {
          userId: refunded.userId,
          chargeId,
          error,
        });
      }
    }
    await ctx.reply(
      refunded.revokeAccess
        ? "Your payment was refunded and membership access has been revoked."
        : "Your payment was refunded. Your current membership access was not affected.",
    );
  });

  bot.on("chat_join_request", async (ctx) => {
    const request = ctx.chatJoinRequest;
    if (request.chat.id !== config.membershipChatId) return;

    if (await store.hasActiveMembership(request.from.id)) {
      await ctx.api.approveChatJoinRequest(request.chat.id, request.from.id);
    } else {
      await ctx.api.declineChatJoinRequest(request.chat.id, request.from.id);
    }
  });

  bot.on("chat_member", async (ctx) => {
    const update = ctx.chatMember;
    if (update.chat.id !== config.membershipChatId) return;
    const member = update.new_chat_member;
    const isJoined =
      member.status === "member" ||
      (member.status === "restricted" && member.is_member);
    if (!isJoined || await store.hasActiveMembership(member.user.id)) return;

    try {
      await bot.api.banChatMember(config.membershipChatId, member.user.id);
      await bot.api.unbanChatMember(config.membershipChatId, member.user.id);
      console.warn("Removed a non-member from the private livestream channel", {
        userId: member.user.id,
      });
    } catch (error) {
      console.error("Could not remove an unauthorized channel member", {
        userId: member.user.id,
        error,
      });
    }
  });

  bot.command("access", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    if (!(await store.hasActiveMembership(ctx.from.id))) {
      await ctx.reply("An active lifetime membership is required. Use /buy to purchase one.");
      return;
    }
    await sendAccessLink(bot, config, ctx.from.id);
  });

  bot.command("link", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    if (!(await store.hasActiveMembership(ctx.from.id))) {
      await ctx.reply("Purchase a lifetime membership first. Use /buy to continue.");
      return;
    }
    await ctx.reply(`Your direct affiliate link:\nhttps://t.me/${config.botUsername}?start=${ctx.from.id}`);
  });

  bot.command("referrals", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    const summary = await store.getReferralSummary(ctx.from.id);
    await ctx.reply(
      `Paid direct referrals: ${summary.paidReferralCount}\nPending commission: $${formatCents(summary.pendingCents)} USDT\nMarked paid: $${formatCents(summary.paidCents)} USDT`,
    );
  });

  bot.command("applypanel", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    if (!(await store.hasActiveMembership(ctx.from.id))) {
      await ctx.reply("Panel applications are for active members. Use /buy to become a member.");
      return;
    }
    const application = ctx.match.trim();
    if (application.length < 20 || application.length > 2000) {
      await ctx.reply("Submit 20–2000 characters after the command, for example:\n/applypanel I would like to discuss...");
      return;
    }

    await store.submitPanelApplication(ctx.from.id, application);
    await ctx.reply("Your panel application has been sent to the hosts for separate review. Referrals do not guarantee a panel place.");
  });

  bot.command("payouts", async (ctx) => {
    if (!isPrivate(ctx) || ctx.from?.id !== config.adminUserId) return;
    const commissions = await store.listPendingCommissions();
    if (commissions.length === 0) {
      await ctx.reply("There are no pending affiliate commissions.");
      return;
    }

    const rows = commissions.map((commission) => {
      const username = commission.username ? `@${commission.username}` : "no username";
      return `#${commission.id}: ${username} (Telegram ID ${commission.referrerId}), $${formatCents(commission.amountCents)} USDT, eligible ${commission.eligibleAfter.toISOString()}`;
    });
    await ctx.reply(rows.join("\n"));
  });

  bot.command("markpaid", async (ctx) => {
    if (!isPrivate(ctx) || ctx.from?.id !== config.adminUserId) return;
    const [commissionId, reference, extra] = ctx.match.trim().split(/\s+/);
    if (!commissionId || !reference || extra || !/^\d+$/.test(commissionId) || !/^[A-Za-z0-9:_-]{4,128}$/.test(reference)) {
      await ctx.reply("Usage: /markpaid <commission_id> <public_transaction_reference>");
      return;
    }

    const marked = await store.markCommissionPaid(
      commissionId,
      config.adminUserId,
      reference,
    );
    await ctx.reply(
      marked
        ? `Commission #${commissionId} marked paid.`
        : "Commission was not marked paid. Check the ID, pending status, and hold-period eligibility.",
    );
  });

  bot.command("panelqueue", async (ctx) => {
    if (!isPrivate(ctx) || ctx.from?.id !== config.adminUserId) return;
    const applications = await store.listPanelApplications(10);
    if (applications.length === 0) {
      await ctx.reply("There are no pending panel applications.");
      return;
    }

    const rows = applications.map((application) => {
      const username = application.username ? `@${application.username}` : "no username";
      return `#${application.id} from ${username} (Telegram ID ${application.userId})\n${application.application.slice(0, 180)}`;
    });
    await ctx.reply(rows.join("\n\n"));
  });

  bot.command("paneldecision", async (ctx) => {
    if (!isPrivate(ctx) || ctx.from?.id !== config.adminUserId) return;
    const [applicationId, decision, extra] = ctx.match.trim().split(/\s+/);
    if (
      !applicationId ||
      !/^\d+$/.test(applicationId) ||
      (decision !== "selected" && decision !== "declined") ||
      extra
    ) {
      await ctx.reply("Usage: /paneldecision <application_id> <selected|declined>");
      return;
    }

    const userId = await store.decidePanelApplication(
      applicationId,
      config.adminUserId,
      decision,
    );
    if (!userId) {
      await ctx.reply("No pending application was found with that ID.");
      return;
    }

    await ctx.reply(`Application #${applicationId} marked ${decision}.`);
    try {
      await bot.api.sendMessage(
        Number(userId),
        decision === "selected"
          ? "The hosts selected your panel application. They will contact you with details."
          : "The hosts reviewed your panel application and did not select it this time.",
      );
    } catch (error) {
      console.error("Could not notify member about panel decision", {
        applicationId,
        userId,
        error,
      });
    }
  });

  bot.catch(async (error) => {
    console.error("Telegram bot update failed", error);
    const ctx = error.ctx;
    if (ctx.chat?.type === "private") {
      try {
        await ctx.reply("We couldn't complete that request. Please try again later or contact the bot administrator.");
      } catch (replyError) {
        console.error("Could not send request-failure notice", replyError);
      }
    }
  });

  return bot;
}

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

async function sendMembershipInvoice(
  ctx: Context,
  config: Config,
  store: DataStore,
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  if (await store.hasActiveMembership(ctx.from.id)) {
    await ctx.reply("Your lifetime membership is already active. Use /access for the livestream link.");
    return;
  }

  const purchase = await store.createOrGetPendingPurchase(
    ctx.from.id,
    config.membershipPriceStars,
  );
  await ctx.api.sendInvoice(
    ctx.chat.id,
    "Lifetime livestream membership",
    "Lifetime access to our exclusive Telegram livestreams.",
    purchase.id,
    "XTR",
    [{ label: "Lifetime membership", amount: purchase.starsAmount }],
  );
}

async function sendAccessLink(
  bot: Bot<Context>,
  config: Config,
  userId: number,
): Promise<void> {
  try {
    const invite = await bot.api.createChatInviteLink(config.membershipChatId, {
      creates_join_request: true,
      expire_date: Math.floor(Date.now() / 1000) + 60 * 60,
      name: `member-${userId}`,
    });
    await bot.api.sendMessage(
      userId,
      `Request access to the exclusive livestream channel here:\n${invite.invite_link}\n\nThe bot will approve the request only for an active member.`,
    );
  } catch (error) {
    console.error("Could not create or send a member access link", { userId, error });
    await bot.api.sendMessage(
      userId,
      "Your membership is active, but we couldn't create an access link right now. Please try /access again later.",
    );
  }
}

function formatCents(amount: number): string {
  return (amount / 100).toFixed(2);
}
