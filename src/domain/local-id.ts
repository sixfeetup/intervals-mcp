import { randomBytes } from "node:crypto";

const SHORT_ID_RE = /^[0-9a-f]{8}$/i;

export function isShortLocalId(localId: string): boolean {
  return SHORT_ID_RE.test(localId);
}

export function formatEditableLocalId(localId: string): string {
  return isShortLocalId(localId) ? localId.slice(0, 8) : localId;
}

export function createShortLocalId(
  exists: (candidate: string) => boolean,
  nextCandidate: () => string = () => randomBytes(4).toString("hex"),
): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = nextCandidate().toLowerCase();
    if (!SHORT_ID_RE.test(candidate)) {
      throw new Error(`short id generator returned invalid id: ${candidate}`);
    }
    if (!exists(candidate)) return candidate;
  }
  throw new Error("could not generate unique short local id");
}

export function resolveLocalId(input: string, candidates: string[], label = "local id"): string | undefined {
  if (candidates.includes(input)) return input;
  if (!SHORT_ID_RE.test(input)) return undefined;

  const matches = candidates.filter((candidate) => candidate.toLowerCase().startsWith(input.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`${label} is ambiguous: ${input}`);
  return undefined;
}
