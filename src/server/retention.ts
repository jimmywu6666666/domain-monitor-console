export const dayMs = 86_400_000;
export const historyRetentionMs = 7 * dayMs;

export function historyCutoff() {
  return new Date(Date.now() - historyRetentionMs);
}
