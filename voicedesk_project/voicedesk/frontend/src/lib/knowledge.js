const IN_PROGRESS_SOURCE_STATUSES = new Set(["pending", "processing"]);

export function normalizeKnowledgeQuestion(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildKnowledgeSearchPayload({ companyId, question, topK = 3 }) {
  return {
    company_id: companyId,
    query: normalizeKnowledgeQuestion(question),
    topK,
  };
}

export function getKnowledgeChunkNumber(chunkIndex) {
  const parsed = Number(chunkIndex);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed + 1 : null;
}

export function hasKnowledgeWorkInProgress(sources) {
  return Array.isArray(sources)
    && sources.some((source) => IN_PROGRESS_SOURCE_STATUSES.has(source?.status));
}
