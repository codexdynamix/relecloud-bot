export interface Config {
  botToken: string;
  databasePath: string;
  adminUserId: number;
  membershipChatId: number;
  botUsername: string;
  membershipPriceStars: number;
  commissionHoldDays: number;
  miniAppHost: string;
  miniAppPort: number;
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = requiredString(env, name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const botUsername = requiredString(env, "BOT_USERNAME").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
    throw new Error("BOT_USERNAME must be a valid Telegram bot username");
  }
  const membershipChatId = Number(requiredString(env, "MEMBERSHIP_CHAT_ID"));
  if (!Number.isSafeInteger(membershipChatId) || membershipChatId === 0) {
    throw new Error("MEMBERSHIP_CHAT_ID must be a non-zero safe integer");
  }
  const miniAppPort = env.MINI_APP_PORT?.trim()
    ? positiveInteger(env, "MINI_APP_PORT")
    : env.PORT?.trim()
      ? positiveInteger(env, "PORT")
      : 3000;
  if (miniAppPort > 65535) {
    throw new Error("MINI_APP_PORT must be between 1 and 65535");
  }

  return {
    botToken: requiredString(env, "BOT_TOKEN"),
    databasePath: env.DATABASE_PATH?.trim() || "./data/relecloutbot.sqlite",
    adminUserId: positiveInteger(env, "ADMIN_USER_ID"),
    membershipChatId,
    botUsername,
    membershipPriceStars: positiveInteger(env, "MEMBERSHIP_PRICE_STARS"),
    commissionHoldDays: positiveInteger(env, "COMMISSION_HOLD_DAYS"),
    miniAppHost: env.MINI_APP_HOST?.trim() || (env.PORT ? "0.0.0.0" : "127.0.0.1"),
    miniAppPort,
  };
}
