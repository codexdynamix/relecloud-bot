# Telegram livestream membership bot

This project provides a Telegram Mini App for lifetime livestream membership, one-level affiliate commissions, member-only channel access, and separate panel applications. The app opens inside Telegram from a channel button; Telegram does not embed it in the channel message feed.

## Important checkout limitation

Telegram requires bots to use Telegram Stars (`XTR`) when selling digital goods or services inside Telegram. This project therefore does not accept USDT for the in-bot livestream membership purchase. See [Telegram's Stars payment documentation](https://core.telegram.org/bots/payments-stars).

Stars prices are configured in `MEMBERSHIP_PRICE_STARS`; they are not a fixed USD/USDT amount. Set the price after reviewing Telegram's current Stars pricing and fees. The bot records a fixed $1.00 USDT commission for one direct referral's verified paid membership; Telegram or payout fees can change the service's net proceeds, so do not assume the remaining amount is exactly $4.00.

## Features

- The Mini App authenticates each request using Telegram's signed `initData` and shows membership status, Stars checkout, channel access, affiliate totals/link, and panel applications in one dashboard.
- The configured admin also gets a private host console in the Mini App to review panel applications and record eligible manual payouts.
- The Mini App is served by the bot process on port `3000` by default. It must be exposed through an HTTPS reverse proxy or hosting platform before Telegram can launch it for users.
- `/start <referrer_id>` records first-touch attribution only when the referrer has an active membership. Self-referrals are rejected.
- `/buy` creates a Telegram Stars invoice. Mini App purchases use Telegram's invoice sheet; a commission is recorded only after a matching successful payment update.
- `/access` creates a one-hour, join-request-only channel link. The bot approves requests only for active members and removes unauthorized direct joins.
- `/link` reveals an affiliate deep link only to active members.
- `/referrals` shows paid direct referrals, pending USDT commissions, and commissions an admin marked paid.
- Pending commissions cannot be marked paid until `COMMISSION_HOLD_DAYS` has elapsed. Admins transfer USDT separately and record the public transaction reference with `/markpaid <commission_id> <reference>`.
- `/applypanel <application text>` submits a separate application. The admin can review it with `/panelqueue` and decide with `/paneldecision <application_id> <selected|declined>`. Referral count does not guarantee a panel place.
- A Telegram Stars refund update revokes membership and cancels any unpaid commission for that sale.

## Setup

Requirements: Node.js 24+ and a Telegram bot created through [@BotFather](https://t.me/BotFather). Membership, referral, and application records are stored in a local SQLite database; no separate database service is required.

1. Copy `.env.example` to `.env`.
2. Set `BOT_TOKEN` in your local `.env`. Never paste the BotFather token into chat or commit `.env`. Your Telegram admin ID and a starting membership price of 250 Stars are already set; Stars are not a fixed USD amount, so review the displayed checkout price before launch. The private channel ID and bot username are already filled in for the channel and bot created for this project.
3. Set `COMMISSION_HOLD_DAYS` to the refund/verification period used by your published terms. The example value is a placeholder, not a legal or financial recommendation.
4. The bot has been added as an administrator of the private livestream channel with invite/member-access and ban permissions. Telegram retains a primary invite link for channel owners; do not share that link. The bot removes anyone who bypasses membership checks by joining directly.
5. Install and run:

   ```powershell
   npm.cmd install
   npm.cmd test
   npm.cmd start
   ```

Run `npm.cmd start` from this project directory and keep the process running for the bot to respond. Run one bot process at a time. Back up `data/relecloutbot.sqlite` and establish written membership, refund, commission, privacy, and tax terms before accepting payments. Affiliate payouts are manual; the bot never stores wallet keys or sends USDT.

## Mini App deployment

The Mini App server binds to `127.0.0.1:3000` by default. Put it behind a stable public HTTPS domain using a reverse proxy or hosting platform with persistent storage for the SQLite database. For container platforms that require binding to all interfaces, set `MINI_APP_HOST=0.0.0.0` and `MINI_APP_PORT` to the port supplied by the platform. Keep `.env`, the database, and the BotFather token private; do not expose the database file through the web server.

After the HTTPS URL is live:

1. In `@BotFather`, open `/mybots` → `@relecloutbot` → **Bot Settings** → **Configure Mini App** and set the Mini App URL to the public HTTPS address. Enable it as the bot's **Main Mini App**.
2. Set the main app link for channel buttons to `https://t.me/relecloutbot?startapp=home`. Referral links use `https://t.me/relecloutbot?startapp=ref_<telegram_user_id>`.
3. Update the pinned channel menu to open the Main Mini App. The app remains inside Telegram but opens as an app view; it cannot be permanently embedded in a channel post.
4. Verify `/health` is reachable through the HTTPS proxy, then test launch, a Stars checkout, access-link generation, referrals, and panel applications in Telegram before public promotion.

Do not announce the Mini App as live until the BotFather URL is configured and the backend is deployed with durable storage. The existing pinned message should be switched to the Main Mini App link after deployment.

## Admin commands

- `/payouts` lists pending direct-referral commissions.
- `/markpaid <commission_id> <public_transaction_reference>` records a manual payout after the hold period.
- `/panelqueue` lists pending panel applications.
- `/paneldecision <application_id> <selected|declined>` records the hosts' decision.

The admin account must start the bot once before using admin commands.
