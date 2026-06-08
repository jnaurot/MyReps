const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalizedEntity = String(entity).toLowerCase();

    if (normalizedEntity.startsWith("#x")) {
      const codePoint = Number.parseInt(normalizedEntity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalizedEntity.startsWith("#")) {
      const codePoint = Number.parseInt(normalizedEntity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return HTML_ENTITY_MAP[normalizedEntity] ?? match;
  });
}

function normalizePlainText(text?: string | null): string | null {
  if (!text) return null;

  return decodeHtmlEntities(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSummaryText(
  summary?: string | null,
  title?: string | null,
): string | null {
  const normalizedSummary = normalizePlainText(summary);
  if (!normalizedSummary) return null;

  const normalizedTitle = normalizePlainText(title);
  if (
    normalizedTitle &&
    normalizedSummary.startsWith(normalizedTitle) &&
    normalizedSummary.length > normalizedTitle.length
  ) {
    const remainder = normalizedSummary.slice(normalizedTitle.length).trimStart();
    if (!remainder) return normalizedTitle;
    if (/^[:;,.!?-]/.test(remainder)) {
      return `${normalizedTitle}${remainder}`;
    }
    return `${normalizedTitle}: ${remainder}`;
  }

  return normalizedSummary;
}
