import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { Bot, Context } from "grammy";
import type { Config } from "./config.js";
import { DataStore } from "./db.js";
import { verifyMiniAppInitData } from "./miniapp-auth.js";
import { parseReferrerId } from "./referral.js";

const WEBAPP_FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
};

export async function startMiniAppServer(
  bot: Bot<Context>,
  config: Config,
  store: DataStore,
): Promise<Server> {
  await Promise.all(
    Object.values(WEBAPP_FILES).map(({ file }) =>
      readFile(new URL(`../webapp/${file}`, import.meta.url)),
    ),
  );

  const server = createServer((request, response) => {
    applySecurityHeaders(response);
    void handleRequest(request, response, bot, config, store).catch((error: unknown) => {
      if (error instanceof UnauthorizedError) {
        sendJson(response, 401, { error: "Open this app from Telegram to continue." });
        return;
      }
      if (error instanceof BadRequestError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      console.error("Mini App request failed", safeErrorMessage(error, config.botToken));
      if (!response.headersSent) sendJson(response, 500, { error: "Request failed. Please try again." });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.miniAppPort, config.miniAppHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  console.info(`Mini App server is listening on ${config.miniAppHost}:${config.miniAppPort}`);
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bot: Bot<Context>,
  config: Config,
  store: DataStore,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  const webAppFile = request.method === "GET" ? WEBAPP_FILES[url.pathname] : undefined;
  if (webAppFile) {
    const body = await readFile(new URL(`../webapp/${webAppFile.file}`, import.meta.url));
    response.writeHead(200, {
      "Content-Type": webAppFile.contentType,
      "Cache-Control": "no-store",
    });
    response.end(body);
    return;
  }

  if (url.pathname === "/api/me" && request.method === "GET") {
    const { user, startParameter } = authenticate(request, config);
    const referrerParameter = startParameter?.match(/^ref_(\d+)$/)?.[1] ??
      (startParameter && /^\d+$/.test(startParameter) ? startParameter : "");
    await store.registerUser(
      user.id,
      user.username,
      parseReferrerId(referrerParameter, user.id),
    );

    const [membershipActive, referrals, panelApplication] = await Promise.all([
      store.hasActiveMembership(user.id),
      store.getReferralSummary(user.id),
      store.getLatestPanelApplication(user.id),
    ]);
    sendJson(response, 200, {
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name ?? "",
        username: user.username ?? null,
        photoUrl: user.photo_url ?? null,
      },
      isAdmin: user.id === config.adminUserId,
      membershipActive,
      priceStars: config.membershipPriceStars,
      referralLink: membershipActive
        ? `https://t.me/${config.botUsername}?startapp=ref_${user.id}`
        : null,
      referrals,
      panelApplication,
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const { user } = authenticate(request, config);
    if (url.pathname === "/api/admin/overview" && request.method === "GET") {
      if (user.id !== config.adminUserId) {
        sendJson(response, 403, { error: "Admin access is required." });
        return;
      }
      const [commissions, applications] = await Promise.all([
        store.listPendingCommissions(50),
        store.listPanelApplications(50),
      ]);
      sendJson(response, 200, {
        commissions: commissions.map((commission) => ({
          id: commission.id,
          username: commission.username,
          referrerId: commission.referrerId,
          amountCents: commission.amountCents,
          eligibleAfter: commission.eligibleAfter.toISOString(),
          eligible: commission.eligibleAfter.getTime() <= Date.now(),
        })),
        applications: applications.map((application) => ({
          id: application.id,
          username: application.username,
          userId: application.userId,
          application: application.application,
          createdAt: application.createdAt.toISOString(),
        })),
      });
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/admin/")) {
      if (user.id !== config.adminUserId) {
        sendJson(response, 403, { error: "Admin access is required." });
        return;
      }
      const body = await readJsonBody(request);

      if (url.pathname === "/api/admin/panel-decision") {
        const applicationId = typeof body.applicationId === "string"
          ? body.applicationId
          : "";
        const decision = body.decision;
        if (!/^\d+$/.test(applicationId) || (decision !== "selected" && decision !== "declined")) {
          sendJson(response, 400, { error: "Choose an application and a valid decision." });
          return;
        }
        const userId = await store.decidePanelApplication(
          applicationId,
          user.id,
          decision,
        );
        if (!userId) {
          sendJson(response, 404, { error: "That application is no longer pending." });
          return;
        }
        try {
          await bot.api.sendMessage(
            Number(userId),
            decision === "selected"
              ? "The hosts selected your panel application. They will contact you with details."
              : "The hosts reviewed your panel application and did not select it this time.",
          );
        } catch (error) {
          console.error("Could not notify member about Mini App panel decision", {
            applicationId,
            userId,
            error: safeErrorMessage(error, config.botToken),
          });
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/admin/mark-paid") {
        const commissionId = typeof body.commissionId === "string"
          ? body.commissionId
          : "";
        const reference = typeof body.reference === "string" ? body.reference : "";
        if (
          !/^\d+$/.test(commissionId) ||
          !/^[A-Za-z0-9:_-]{4,128}$/.test(reference)
        ) {
          sendJson(response, 400, { error: "Enter a valid commission ID and transaction reference." });
          return;
        }
        const marked = await store.markCommissionPaid(
          commissionId,
          user.id,
          reference,
        );
        if (!marked) {
          sendJson(response, 409, { error: "Not marked paid. Check the ID, pending status, and hold-period eligibility." });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/invoice") {
      await store.registerUser(user.id, user.username, null);
      if (await store.hasActiveMembership(user.id)) {
        sendJson(response, 409, { error: "Your lifetime membership is already active." });
        return;
      }

      const purchase = await store.createOrGetPendingPurchase(
        user.id,
        config.membershipPriceStars,
      );
      const invoiceLink = await bot.api.createInvoiceLink(
        "Lifetime livestream membership",
        "Lifetime access to our exclusive Telegram livestreams.",
        purchase.id,
        "",
        "XTR",
        [{ label: "Lifetime membership", amount: purchase.starsAmount }],
      );
      sendJson(response, 200, { invoiceLink });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/access") {
      if (!(await store.hasActiveMembership(user.id))) {
        sendJson(response, 403, { error: "An active membership is required for channel access." });
        return;
      }
      const invite = await bot.api.createChatInviteLink(config.membershipChatId, {
        creates_join_request: true,
        expire_date: Math.floor(Date.now() / 1000) + 60 * 60,
        name: `member-${user.id}`,
      });
      sendJson(response, 200, { inviteLink: invite.invite_link });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/panel-application") {
      if (!(await store.hasActiveMembership(user.id))) {
        sendJson(response, 403, { error: "An active membership is required to apply for a panel." });
        return;
      }
      const body = await readJsonBody(request);
      const application = typeof body.application === "string" ? body.application.trim() : "";
      if (application.length < 20 || application.length > 2000) {
        sendJson(response, 400, { error: "Your application must be 20–2000 characters." });
        return;
      }

      await store.submitPanelApplication(user.id, application);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, request.method === "POST" ? 404 : 405, { error: "Not found." });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function authenticate(
  request: IncomingMessage,
  config: Config,
): ReturnType<typeof verifyMiniAppInitData> {
  const initData = request.headers["x-telegram-init-data"];
  if (typeof initData !== "string") {
    throw new UnauthorizedError();
  }
  try {
    return verifyMiniAppInitData(initData, config.botToken);
  } catch {
    throw new UnauthorizedError();
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new BadRequestError("Request must use application/json.");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 8_192) throw new BadRequestError("Request body is too large.");
    chunks.push(buffer);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("Request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function safeErrorMessage(error: unknown, botToken: string): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replaceAll(botToken, "[redacted]");
}

class UnauthorizedError extends Error {}
class BadRequestError extends Error {}
