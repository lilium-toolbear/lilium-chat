export interface SlashTokenOk {
  ok: true;
  token: string;
}

export interface SlashTokenError {
  ok: false;
  error: string;
}

export type SlashTokenResult = SlashTokenOk | SlashTokenError;

export interface CollectedSlashTokens {
  ok: true;
  canonical: string;
  aliases: string[];
  all: string[];
}

export type CollectSlashTokensResult = CollectedSlashTokens | SlashTokenError;

export function normalizeSlashToken(input: string): string {
  return input
    .trim()
    .replace(/^\/+/, "")
    .normalize("NFKC")
    .toLowerCase();
}

export function validateSlashToken(raw: string): SlashTokenResult {
  const token = normalizeSlashToken(raw);
  if (!token) return { ok: false, error: "empty" };
  if ([...token].length > 32) return { ok: false, error: "too_long" };
  if (/\s/.test(token)) return { ok: false, error: "invalid_characters" };
  if (/[\u0000-\u001f\u007f]/.test(token)) return { ok: false, error: "invalid_characters" };
  if (token.includes("/")) return { ok: false, error: "invalid_characters" };
  return { ok: true, token };
}

export function collectSlashTokens(name: string, aliases: string[]): CollectSlashTokensResult {
  const canonicalResult = validateSlashToken(name);
  if (!canonicalResult.ok) return canonicalResult;

  const normalizedAliases: string[] = [];
  const seen = new Set<string>([canonicalResult.token]);

  for (const raw of aliases) {
    const v = validateSlashToken(String(raw));
    if (!v.ok) return v;
    if (seen.has(v.token)) return { ok: false, error: "duplicate_in_request" };
    seen.add(v.token);
    normalizedAliases.push(v.token);
  }

  return {
    ok: true,
    canonical: canonicalResult.token,
    aliases: normalizedAliases,
    all: [canonicalResult.token, ...normalizedAliases],
  };
}

/** Returns true when invoked_name is empty (optional) or matches snapshot canonical/alias tokens. */
export function invokedNameMatchesSnapshot(
  invokedName: string,
  canonicalName: string,
  aliases: readonly string[],
): boolean {
  if (!invokedName.trim()) return true;
  const normalized = normalizeSlashToken(invokedName);
  if (normalized === normalizeSlashToken(canonicalName)) return true;
  return aliases.some((alias) => normalizeSlashToken(alias) === normalized);
}
