import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { DataStore } from "./db.js";
import { DatabaseSync } from "node:sqlite";
import { startMiniAppServer } from "./miniapp.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const databasePath = resolve(config.databasePath);
  await mkdir(dirname(databasePath), { recursive: true });
  const store = new DataStore(new DatabaseSync(databasePath));

  try {
    await store.initialize();
    const bot = createBot(config, store);
    const botInfo = await bot.api.getMe();
    if (botInfo.username !== config.botUsername) {
      throw new Error(
        `BOT_USERNAME does not match the token's bot username (@${botInfo.username})`,
      );
    }

    await bot.api.setMyCommands([
      { command: "start", description: "Start the membership bot" },
      { command: "buy", description: "Purchase lifetime membership" },
      { command: "access", description: "Request livestream channel access" },
      { command: "link", description: "Get your affiliate link" },
      { command: "referrals", description: "View direct referral commissions" },
      { command: "applypanel", description: "Apply for a livestream panel" },
    ]);

    const miniAppServer = await startMiniAppServer(bot, config, store);
    process.once("SIGINT", () => bot.stop());
    process.once("SIGTERM", () => bot.stop());
    try {
      await bot.start({
        allowed_updates: [
          "message",
          "pre_checkout_query",
          "chat_join_request",
          "chat_member",
        ],
        onStart: (info) => console.info(`Bot @${info.username} is running`),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        miniAppServer.close((error) => error ? reject(error) : resolve());
      });
    }
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error("Fatal bot startup error", error);
  process.exitCode = 1;
});
