import { isRecordingConsentRefusal } from "../privacy/consent.js";

const POST_CALL_TRANSCRIPTION_TYPE = "post_call_transcription";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export class PostCallPersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostCallPersistenceError";
  }
}

export function isPostCallTranscription(body) {
  return body?.type === POST_CALL_TRANSCRIPTION_TYPE;
}

export function normalizeConversationId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 255
    || CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Détecte un refus uniquement dans les tours de parole du client.
 *
 * Un « non » isolé n'est interprété comme un refus que dans le premier tour
 * client, immédiatement après l'annonce obligatoire. Les refus explicites
 * (« je refuse l'enregistrement », etc.) restent valides à tout moment.
 */
export function transcriptHasConsentRefusal(transcript) {
  if (!Array.isArray(transcript)) return false;

  let callerTurn = 0;
  for (const entry of transcript) {
    const role = String(entry?.role ?? "").trim().toLowerCase();
    if (role !== "user") continue;

    const message = entry?.message ?? entry?.content ?? entry?.text;
    if (typeof message !== "string" || !message.trim()) continue;

    callerTurn += 1;
    if (
      isRecordingConsentRefusal(message, {
        allowBareRefusal: callerTurn === 1,
      })
    ) {
      return true;
    }
  }

  return false;
}

export function isUniqueViolation(error) {
  return error?.code === "23505";
}

export async function findExistingPostCall({
  supabase,
  companyId,
  conversationId,
}) {
  const { data, error } = await supabase
    .from("calls")
    .select("id")
    .eq("company_id", companyId)
    .eq("elevenlabs_conversation_id", conversationId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new PostCallPersistenceError("post-call idempotency lookup failed");
  }
  return data || null;
}

/**
 * Réserve l'identifiant de conversation avant tout effet secondaire.
 *
 * L'index unique PostgreSQL reste l'autorité en cas de course entre deux
 * livraisons simultanées. Le pré-check évite le travail inutile dans le cas
 * normal, puis le code 23505 est requalifié en doublon uniquement si la ligne
 * appartient bien au tenant résolu.
 */
export async function reservePostCall({
  supabase,
  companyId,
  conversationId,
  callRow,
}) {
  const existing = await findExistingPostCall({
    supabase,
    companyId,
    conversationId,
  });
  if (existing?.id) {
    return { status: "duplicate", callId: existing.id };
  }

  const { data: inserted, error } = await supabase
    .from("calls")
    .insert(callRow)
    .select("id")
    .single();

  if (!error && inserted?.id) {
    return { status: "inserted", callId: inserted.id };
  }

  if (isUniqueViolation(error)) {
    const concurrent = await findExistingPostCall({
      supabase,
      companyId,
      conversationId,
    });
    if (concurrent?.id) {
      return { status: "duplicate", callId: concurrent.id };
    }
    return { status: "conflict", callId: null };
  }

  throw new PostCallPersistenceError("post-call primary insert failed");
}
