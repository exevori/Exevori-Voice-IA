export const PROVIDERS = ["twilio", "elevenlabs", "groq", "supabase", "stripe", "resend"];
export const STATUS = {
  ok: { label: "API accessible", variant: "green", color: "#22c55e" },
  down: { label: "Vérification en échec", variant: "red", color: "#ef4444" },
  unauthorized: { label: "Accès refusé", variant: "orange", color: "#f97316" },
  not_configured: { label: "Non configuré", variant: "outline", color: "#a3a3a3" },
  unknown: { label: "Non vérifié", variant: "outline", color: "#525252" },
  stale: { label: "Mesure périmée", variant: "outline", color: "#525252" },
};

export function providerRows(snapshot, nowMs = Date.now(), failed = false) {
  return PROVIDERS.map(provider => {
    const row = snapshot?.providers?.find(item => item.provider === provider);
    if (failed || !row) return { provider, status: "unknown", latency_ms: null };
    const timestamp = Date.parse(row.checked_at);
    const stale = !Number.isFinite(timestamp) || nowMs - timestamp > 150_000 || timestamp > nowMs + 30_000;
    return { ...row, status: stale ? "stale" : STATUS[row.status] ? row.status : "unknown",
      latency_ms: stale ? null : Number.isFinite(row.latency_ms) ? row.latency_ms : null };
  });
}

export function historyBuckets(history, provider, nowMs = Date.now()) {
  const size = 900_000;
  const end = Math.floor(nowMs / size) * size;
  const indexed = new Map((history || []).filter(row => row.provider === provider)
    .map(row => [Date.parse(row.bucket), row]));
  return Array.from({ length: 97 }, (_, index) => {
    const time = end - (96 - index) * size;
    const row = indexed.get(time);
    return { time, status: row && STATUS[row.status] ? row.status : "unknown",
      count: Number(row?.sample_count) || 0,
      partial: !row || Number(row.sample_count) < 10,
      latency: row?.latency_ms ?? null };
  });
}

export function overallStatus(rows) {
  if (rows.some(row => row.status === "down")) return "Échec de connexion détecté";
  if (rows.some(row => row.status === "unauthorized")) return "Accès fournisseur à vérifier";
  if (rows.some(row => row.status !== "ok") || rows.length !== PROVIDERS.length) return "Vérification incomplète";
  return "Les six API sont accessibles";
}

export function probeDetail(row) {
  if (row.status === "stale") return "Aucune mesure récente. Vérifiez le worker de monitoring.";
  if (row.detail === "missing_configuration") return "Variables d’environnement requises absentes.";
  if (row.detail === "invalid_configuration") return "Configuration invalide ; aucune requête envoyée.";
  if (row.detail === "timeout") return "Délai de réponse dépassé.";
  if (row.detail === "api_access_verified") return "Contrôle en lecture seule réussi, sans opération métier.";
  if (row.status === "unauthorized") return "Clé ou permission de lecture à vérifier ; cela ne prouve pas une panne fournisseur.";
  return row.status === "unknown" ? "Résultat indisponible." : "Consultez les accès et l’état du fournisseur.";
}
