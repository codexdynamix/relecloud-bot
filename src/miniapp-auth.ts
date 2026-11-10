import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramMiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export interface VerifiedMiniAppInitData {
  user: TelegramMiniAppUser;
  startParameter: string | null;
}

export function verifyMiniAppInitData(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifiedMiniAppInitData {
  if (!initData || initData.length > 16_384) {
    throw new Error("Missing or oversized Telegram initialization data");
  }

  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(initData)) {
    if (fields.has(key)) {
      throw new Error("Telegram initialization data contains duplicate fields");
    }
    fields.set(key, value);
  }

  const suppliedHash = fields.get("hash");
  const authDateText = fields.get("auth_date");
  const userText = fields.get("user");
  if (
    !suppliedHash ||
    !/^[a-f0-9]{64}$/i.test(suppliedHash) ||
    !authDateText ||
    !/^\d+$/.test(authDateText) ||
    !userText
  ) {
    throw new Error("Telegram initialization data is incomplete");
  }

  const authDate = Number(authDateText);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > nowSeconds + 30 ||
    nowSeconds - authDate > 86_400
  ) {
    throw new Error("Telegram initialization data has expired");
  }

  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();
  const actualHash = Buffer.from(suppliedHash, "hex");
  if (
    actualHash.length !== expectedHash.length ||
    !timingSafeEqual(actualHash, expectedHash)
  ) {
    throw new Error("Telegram initialization data signature is invalid");
  }

  let user: unknown;
  try {
    user = JSON.parse(userText);
  } catch {
    throw new Error("Telegram user data is not valid JSON");
  }
  if (!isTelegramMiniAppUser(user)) {
    throw new Error("Telegram user data is invalid");
  }

  return {
    user,
    startParameter: fields.get("start_param") ?? null,
  };
}

function isTelegramMiniAppUser(value: unknown): value is TelegramMiniAppUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return Number.isSafeInteger(user.id) &&
    typeof user.first_name === "string" &&
    (user.last_name === undefined || typeof user.last_name === "string") &&
    (user.username === undefined || typeof user.username === "string") &&
    (user.photo_url === undefined || typeof user.photo_url === "string");
}
