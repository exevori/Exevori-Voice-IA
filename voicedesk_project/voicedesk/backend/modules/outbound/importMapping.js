export function normalizeImportHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readColumn(row, column) {
  const value = row?.[column];
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function mapImportField(row, ...keys) {
  const columns = Object.keys(row || {}).map(name => {
    const normalized = normalizeImportHeader(name);
    return {
      name,
      normalized,
      tokens: normalized.split("_").filter(Boolean),
    };
  });

  // Exact aliases always win. This prevents `company_name` from being
  // selected as `name` merely because it appears first in a CSV file.
  for (const key of keys) {
    const normalizedKey = normalizeImportHeader(key);
    const column = columns.find(candidate => candidate.normalized === normalizedKey);
    const value = column ? readColumn(row, column.name) : null;
    if (value !== null) return value;
  }

  // Fuzzy token matching is reserved for descriptive aliases such as
  // `telephone` in `telephone_principal`. Generic name/note aliases must be
  // exact to avoid cross-field collisions.
  for (const key of keys) {
    const normalizedKey = normalizeImportHeader(key);
    if (normalizedKey.length < 5 || ["name", "notes"].includes(normalizedKey)) {
      continue;
    }
    const column = columns.find(candidate => candidate.tokens.includes(normalizedKey));
    const value = column ? readColumn(row, column.name) : null;
    if (value !== null) return value;
  }

  return null;
}
