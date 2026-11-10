export function parseReferrerId(payload: string, userId: number): number | null {
  if (!/^\d+$/.test(payload)) {
    return null;
  }

  const referrerId = Number(payload);
  if (
    !Number.isSafeInteger(referrerId) ||
    referrerId <= 0 ||
    referrerId === userId
  ) {
    return null;
  }

  return referrerId;
}
