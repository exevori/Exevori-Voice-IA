// ============================================================
// EXEVORI VOICE IA — Service de provisioning automatique
// Fichier : backend/modules/onboarding/provision_service.js
//
// Responsabilités :
//   1. Acheter un numéro Twilio au Canada (+1 418 ou +1 581)
//   2. Créer un agent ElevenLabs (copie de l'agent maître)
//   3. Importer le numéro Twilio dans ElevenLabs
//   4. Lier le numéro à l'agent ElevenLabs
//   5. Configurer le post-call webhook
//   6. Sauvegarder tout dans Supabase (twilio_configs + phone_numbers)
// ============================================================

import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import { encryptPassword } from "../../lib/crypto.js";
import {
  hasConsentTerminationCapability,
  prefixRecordingConsentFr,
} from "../privacy/consent.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Credentials Twilio MAÎTRE (compte Exevori — pas le client)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const ELEVENLABS_API   = "https://api.elevenlabs.io";
const ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY;
// ID de l'agent maître Léa — template utilisé pour créer les agents clients
const ELEVENLABS_MASTER_AGENT_ID = process.env.ELEVENLABS_MASTER_AGENT_ID;
const ELEVENLABS_CUSTOM_LLM_SECRET =
  process.env.ELEVENLABS_CUSTOM_LLM_SECRET;

const PROVISIONING_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const ALLOWED_PAYMENT_STATUSES = new Set(["active", "active_paid", "trial"]);

function getCustomLlmConfig(agent) {
  return (
    agent?.conversation_config?.agent?.llm?.custom_llm
    || agent?.conversation_config?.agent?.prompt?.llm?.custom_llm
    || null
  );
}

function hasCustomLlmCredential(customLlm) {
  if (!customLlm || typeof customLlm !== "object") return false;
  const credential = customLlm.api_key;
  return (
    (typeof credential === "string" && credential.trim().length > 0)
    || (
      credential
      && typeof credential === "object"
      && (
        typeof credential.secret_id === "string"
        || typeof credential.env_var_label === "string"
      )
    )
  );
}

async function acquireProvisioningLock(companyId) {
  const now = new Date();
  const startedAt = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - PROVISIONING_LOCK_TIMEOUT_MS
  ).toISOString();

  const { data: lock, error: lockError } = await supabase
    .from("onboarding_progress")
    .update({
      provisioning_status: "in_progress",
      provisioning_started_at: startedAt,
      provisioning_error: null,
    })
    .eq("company_id", companyId)
    .or(
      `provisioning_status.neq.in_progress,`
      + `provisioning_status.is.null,`
      + `provisioning_started_at.is.null,`
      + `provisioning_started_at.lt.${staleBefore}`
    )
    .select("company_id, provisioning_status, provisioning_started_at")
    .maybeSingle();

  if (lockError) {
    throw new Error(`Verrou provisioning : ${lockError.message}`);
  }
  if (lock) {
    return {
      acquired: true,
      startedAt: lock.provisioning_started_at,
    };
  }

  const { data: current, error: currentError } = await supabase
    .from("onboarding_progress")
    .select("provisioning_status, provisioning_started_at")
    .eq("company_id", companyId)
    .maybeSingle();

  if (currentError) {
    throw new Error(`Lecture verrou provisioning : ${currentError.message}`);
  }
  if (!current) {
    throw new Error("Progression onboarding introuvable");
  }

  const currentStartedAt = Date.parse(current.provisioning_started_at);
  const retryAfterSeconds = Number.isFinite(currentStartedAt)
    ? Math.max(
        1,
        Math.ceil(
          (currentStartedAt + PROVISIONING_LOCK_TIMEOUT_MS - now.getTime())
          / 1000
        )
      )
    : Math.ceil(PROVISIONING_LOCK_TIMEOUT_MS / 1000);

  return {
    acquired: false,
    startedAt: current.provisioning_started_at,
    retryAfterSeconds,
  };
}

function provisioningLockLostError() {
  const error = new Error(
    "Verrou de provisioning perdu au profit d'une nouvelle tentative"
  );
  error.code = "provisioning_lock_lost";
  return error;
}

async function renewProvisioningLock(companyId, startedAt) {
  const renewedAt = new Date().toISOString();
  const { data: lock, error } = await supabase
    .from("onboarding_progress")
    .update({ provisioning_started_at: renewedAt })
    .eq("company_id", companyId)
    .eq("provisioning_status", "in_progress")
    .eq("provisioning_started_at", startedAt)
    .select("provisioning_started_at")
    .maybeSingle();

  if (error) {
    throw new Error(`Renouvellement verrou provisioning : ${error.message}`);
  }
  if (!lock) throw provisioningLockLostError();
  return lock.provisioning_started_at;
}

async function finalizeProvisioningLock(companyId, startedAt, status, errorMessage = null) {
  const { data: lock, error } = await supabase
    .from("onboarding_progress")
    .update({
      provisioning_status: status,
      provisioning_error: errorMessage,
    })
    .eq("company_id", companyId)
    .eq("provisioning_status", "in_progress")
    .eq("provisioning_started_at", startedAt)
    .select("company_id")
    .maybeSingle();

  if (error) {
    throw new Error(`Finalisation verrou provisioning : ${error.message}`);
  }
  return Boolean(lock);
}

async function rollbackPersistedConfig(companyId, results, log) {
  if (!results.databasePersistenceStarted) {
    return { resourcesAdopted: false };
  }

  if (results.phoneNumberPersistenceAttempted) {
    try {
      const { data: deletedRows, error } = await supabase
        .from("phone_numbers")
        .delete()
        .eq("company_id", companyId)
        .eq("phone_number", results.twilioPhoneNumber)
        .eq("twilio_phone_sid", results.twilioPhoneSid)
        .eq("elevenlabs_agent_id", results.elevenLabsAgentId)
        .eq("elevenlabs_phone_number_id", results.elevenLabsPhoneNumberId)
        .eq("updated_at", results.resourceOwnershipToken)
        .select("id");
      if (error) throw error;

      if (!deletedRows?.length) {
        const { data: adoptedRow, error: adoptedError } = await supabase
          .from("phone_numbers")
          .select("id")
          .eq("company_id", companyId)
          .eq("phone_number", results.twilioPhoneNumber)
          .eq("twilio_phone_sid", results.twilioPhoneSid)
          .eq("elevenlabs_agent_id", results.elevenLabsAgentId)
          .eq("elevenlabs_phone_number_id", results.elevenLabsPhoneNumberId)
          .maybeSingle();
        if (adoptedError) throw adoptedError;
        if (adoptedRow) {
          log.push(
            "Rollback annulé : les ressources ont été reprises par une nouvelle tentative"
          );
          return { resourcesAdopted: true };
        }
      } else {
        log.push("Rollback DB : ligne phone_numbers de cette tentative supprimée");
      }
    } catch (error) {
      log.push(`Rollback DB phone_numbers échoué : ${error.message}`);
    }
  }

  try {
    const previous = results.previousAssistantConfig;
    const { error } = await supabase
      .from("assistant_configs")
      .update({
        twilio_number: previous.twilio_number,
        elevenlabs_agent_id: previous.elevenlabs_agent_id,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", companyId)
      .eq("twilio_number", results.twilioPhoneNumber)
      .eq("elevenlabs_agent_id", results.elevenLabsAgentId);
    if (error) throw error;
    log.push("Rollback DB : assistant_configs restaurée");
  } catch (error) {
    log.push(`Rollback DB assistant_configs échoué : ${error.message}`);
  }

  try {
    let query;
    if (results.previousTwilioConfig) {
      query = supabase
        .from("twilio_configs")
        .update({
          ...results.previousTwilioConfig,
          updated_at: new Date().toISOString(),
        })
        .eq("company_id", companyId)
        .eq("phone_number", results.twilioPhoneNumber)
        .eq("phone_number_sid", results.twilioPhoneSid);
    } else {
      query = supabase
        .from("twilio_configs")
        .delete()
        .eq("company_id", companyId)
        .eq("phone_number", results.twilioPhoneNumber)
        .eq("phone_number_sid", results.twilioPhoneSid);
    }

    const { error } = await query;
    if (error) throw error;
    log.push("Rollback DB : twilio_configs restaurée");
  } catch (error) {
    log.push(`Rollback DB twilio_configs échoué : ${error.message}`);
  }

  return { resourcesAdopted: false };
}

// ─────────────────────────────────────────────────────────────
// FONCTION PRINCIPALE — Provisionner un nouveau client
// ─────────────────────────────────────────────────────────────
export async function provisionNewClient({ companyId, assistantName, voiceId, systemPrompt, areaCode = "581" }) {
  const log = [];
  const results = {};
  let lockStartedAt = null;

  try {
    // ── GARDE 1 : Réutiliser un numéro déjà provisionné ─────
    const { data: existingNumber, error: existingNumberError } = await supabase
      .from("phone_numbers")
      .select(`
        phone_number,
        twilio_phone_sid,
        elevenlabs_agent_id,
        elevenlabs_phone_number_id,
        status,
        created_at,
        updated_at
      `)
      .eq("company_id", companyId)
      .in("status", ["active", "suspended"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingNumberError) {
      throw new Error(`Vérification numéro existant : ${existingNumberError.message}`);
    }
    if (existingNumber) {
      log.push(
        `Provisioning déjà effectué : réutilisation de ${existingNumber.phone_number}`
      );

      const existingLock = await acquireProvisioningLock(companyId);
      if (!existingLock.acquired) {
        const error = "Provisioning déjà en cours";
        log.push(
          `${error} depuis ${existingLock.startedAt || "une heure inconnue"}`
        );
        return {
          success: false,
          code: "provisioning_in_progress",
          error,
          retry_after_seconds: existingLock.retryAfterSeconds,
          log,
        };
      }

      lockStartedAt = existingLock.startedAt;
      let claimQuery = supabase
        .from("phone_numbers")
        .update({ updated_at: lockStartedAt })
        .eq("company_id", companyId)
        .eq("phone_number", existingNumber.phone_number);
      claimQuery = existingNumber.updated_at
        ? claimQuery.eq("updated_at", existingNumber.updated_at)
        : claimQuery.is("updated_at", null);

      const { data: claimedNumber, error: claimError } = await claimQuery
        .select("phone_number")
        .maybeSingle();
      if (claimError) {
        throw new Error(`Reprise numéro existant : ${claimError.message}`);
      }

      if (!claimedNumber) {
        await finalizeProvisioningLock(
          companyId,
          lockStartedAt,
          "failed",
          "Ressource modifiée pendant la reprise — relancer la tentative"
        );
        lockStartedAt = null;
        return {
          success: false,
          code: "provisioning_retry_required",
          error: "Ressource modifiée pendant la reprise — relancer la tentative",
          retry_after_seconds: 1,
          log,
        };
      }

      const finalized = await finalizeProvisioningLock(
        companyId,
        lockStartedAt,
        "done"
      );
      if (!finalized) throw provisioningLockLostError();
      lockStartedAt = null;

      return {
        success: true,
        existing: true,
        phone_number: existingNumber.phone_number,
        twilio_phone_sid: existingNumber.twilio_phone_sid,
        elevenlabs_agent_id: existingNumber.elevenlabs_agent_id,
        elevenlabs_phone_id: existingNumber.elevenlabs_phone_number_id,
        agent_id: existingNumber.elevenlabs_agent_id,
        log,
      };
    }

    // ── GARDE 2 : Abonnement actif ou en essai ───────────────
    const { data: sub, error: subscriptionError } = await supabase
      .from("subscriptions")
      .select("payment_status")
      .eq("company_id", companyId)
      .maybeSingle();

    if (subscriptionError) {
      throw new Error(`Vérification abonnement : ${subscriptionError.message}`);
    }
    if (!sub || !ALLOWED_PAYMENT_STATUSES.has(sub.payment_status)) {
      const error = "Provisioning refusé : abonnement non actif";
      log.push(error);
      return {
        success: false,
        code: "subscription_inactive",
        error,
        log,
      };
    }
    log.push(`Abonnement vérifié : ${sub.payment_status}`);

    if (!ELEVENLABS_CUSTOM_LLM_SECRET) {
      throw new Error(
        "ELEVENLABS_CUSTOM_LLM_SECRET requis avant le provisioning"
      );
    }

    // Valider le chiffrement avant tout achat de ressource externe.
    const encryptedAuthToken = encryptPassword(process.env.TWILIO_AUTH_TOKEN);

    // ── GARDE 3 : Verrou atomique avec reprise après 5 min ───
    const lock = await acquireProvisioningLock(companyId);
    if (!lock.acquired) {
      const error = "Provisioning déjà en cours";
      log.push(
        `${error} depuis ${lock.startedAt || "une heure inconnue"}`
      );
      return {
        success: false,
        code: "provisioning_in_progress",
        error,
        retry_after_seconds: lock.retryAfterSeconds,
        log,
      };
    }
    lockStartedAt = lock.startedAt;
    log.push("Verrou de provisioning acquis");

    if (
      !ELEVENLABS_KEY
      || !ELEVENLABS_MASTER_AGENT_ID
      || !process.env.TWILIO_ACCOUNT_SID
      || !process.env.TWILIO_AUTH_TOKEN
    ) {
      throw new Error("Configuration fournisseurs de provisioning incomplète");
    }

    // Vérifier le template avant tout achat. Sa duplication conservera les
    // outils, le RAG, le workflow et la référence au secret Custom LLM.
    const masterConfig = await elevenLabsGet(
      `/v1/convai/agents/${ELEVENLABS_MASTER_AGENT_ID}`
    );
    if (!hasCustomLlmCredential(getCustomLlmConfig(masterConfig))) {
      throw new Error(
        "Agent maître : authentification Custom LLM absente"
      );
    }
    if (!hasConsentTerminationCapability(masterConfig)) {
      throw new Error(
        "Agent maître : outil de fin d'appel obligatoire absent"
      );
    }
    log.push("Agent maître ElevenLabs vérifié");

    // ── ÉTAPE 1 : Acheter un numéro Twilio ──────────────────
    log.push("Recherche d'un numéro Twilio disponible...");
    const availableNumbers = await twilioClient
      .availablePhoneNumbers("CA")
      .local.list({
        areaCode,
        voiceEnabled: true,
        smsEnabled: false,
        limit: 5,
      });

    if (!availableNumbers.length) {
      // Fallback : essayer le code régional 418 (Québec)
      const fallback = await twilioClient
        .availablePhoneNumbers("CA")
        .local.list({ areaCode: "418", voiceEnabled: true, limit: 5 });
      if (!fallback.length) throw new Error("Aucun numéro disponible au Québec (581 et 418)");
      availableNumbers.push(...fallback);
    }

    const chosenNumber = availableNumbers[0].phoneNumber;
    log.push(`Numéro disponible trouvé : ${chosenNumber}`);

    // Acheter le numéro
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: chosenNumber,
      friendlyName: `VoiceDesk — ${assistantName} (${companyId.slice(0, 8)})`,
    });

    results.twilioPhoneNumber = purchasedNumber.phoneNumber;
    results.twilioPhoneSid    = purchasedNumber.sid;
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    log.push(`Numéro acheté : ${purchasedNumber.phoneNumber} (SID: ${purchasedNumber.sid})`);

    // ── ÉTAPE 2 : Créer un agent ElevenLabs ────────────────
    log.push("Création de l'agent ElevenLabs...");

    // Dupliquer le maître via l'API officielle afin de préserver exactement
    // workflow, outils, RAG, secrets et réglages non représentés dans ce code.
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    const newAgent = await elevenLabsPost(
      `/v1/convai/agents/${ELEVENLABS_MASTER_AGENT_ID}/duplicate`,
      { name: `VoiceDesk — ${assistantName}` }
    );
    results.elevenLabsAgentId = newAgent.agent_id;
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);

    // Personnaliser uniquement les champs propres au client. La duplication
    // conserve les réglages du maître qui ne sont pas modifiés ici.
    await elevenLabsPatch(`/v1/convai/agents/${newAgent.agent_id}`, {
      conversation_config: {
        ...masterConfig.conversation_config,
        agent: {
          ...masterConfig.conversation_config?.agent,
          prompt: {
            ...masterConfig.conversation_config?.agent?.prompt,
            prompt: systemPrompt || masterConfig.conversation_config?.agent?.prompt?.prompt || "",
          },
          first_message: prefixRecordingConsentFr(
            `Je suis ${assistantName}. Comment puis-je vous aider aujourd'hui ?`
          ),
          disable_first_message_interruptions: true,
          language: "fr",
        },
        tts: {
          ...masterConfig.conversation_config?.tts,
          voice_id: voiceId || masterConfig.conversation_config?.tts?.voice_id,
        },
      },
    });

    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    log.push(`Agent ElevenLabs créé : ${newAgent.agent_id}`);

    // ── ÉTAPE 3 : Importer le numéro Twilio dans ElevenLabs ─
    log.push("Import du numéro Twilio dans ElevenLabs...");

    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    const importedNumber = await elevenLabsPost("/v1/convai/phone-numbers/import", {
      phone_number: purchasedNumber.phoneNumber,
      label: `${assistantName} — ${companyId.slice(0, 8)}`,
      sid_account: process.env.TWILIO_ACCOUNT_SID,
    });

    results.elevenLabsPhoneNumberId = importedNumber.phone_number_id;
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    log.push(`Numéro importé dans ElevenLabs : ${importedNumber.phone_number_id}`);

    // ── ÉTAPE 4 : Lier le numéro à l'agent ─────────────────
    log.push("Liaison numéro → agent ElevenLabs...");

    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    await elevenLabsPatch(`/v1/convai/phone-numbers/${importedNumber.phone_number_id}`, {
      agent_id: newAgent.agent_id,
    });

    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);
    log.push("Numéro lié à l'agent avec succès");

    // ── ÉTAPE 5 : Sauvegarder dans Supabase ────────────────
    log.push("Sauvegarde dans Supabase...");
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);

    const [
      { data: previousTwilioConfig, error: previousTwilioConfigError },
      { data: previousAssistantConfig, error: previousAssistantConfigError },
    ] = await Promise.all([
      supabase
        .from("twilio_configs")
        .select(`
          account_sid,
          auth_token_encrypted,
          auth_token_iv,
          auth_token_tag,
          phone_number,
          phone_number_sid,
          forwarding_number,
          status,
          last_test_at,
          last_test_ok,
          last_test_error,
          twilio_account_name
        `)
        .eq("company_id", companyId)
        .maybeSingle(),
      supabase
        .from("assistant_configs")
        .select("twilio_number, elevenlabs_agent_id")
        .eq("company_id", companyId)
        .maybeSingle(),
    ]);

    if (previousTwilioConfigError) {
      throw new Error(
        `Lecture config Twilio existante : ${previousTwilioConfigError.message}`
      );
    }
    if (previousAssistantConfigError) {
      throw new Error(
        `Lecture config assistant existante : ${previousAssistantConfigError.message}`
      );
    }
    if (!previousAssistantConfig) {
      throw new Error("Config assistant introuvable avant sauvegarde");
    }

    results.previousTwilioConfig = previousTwilioConfig;
    results.previousAssistantConfig = previousAssistantConfig;
    results.databasePersistenceStarted = true;
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);

    // Table twilio_configs (pour la téléphonie)
    const { error: twilioConfigError } = await supabase.from("twilio_configs").upsert({
      company_id:           companyId,
      account_sid:          process.env.TWILIO_ACCOUNT_SID,
      auth_token_encrypted: encryptedAuthToken.ciphertext,
      auth_token_iv:        encryptedAuthToken.iv,
      auth_token_tag:       encryptedAuthToken.tag,
      phone_number:         purchasedNumber.phoneNumber,
      phone_number_sid:     purchasedNumber.sid,
      status:               "active",
      last_test_ok:         true,
      twilio_account_name:  "Exevori VoiceDesk (maître)",
      updated_at:           new Date().toISOString(),
    }, { onConflict: "company_id" });
    if (twilioConfigError) {
      throw new Error(`Sauvegarde Twilio : ${twilioConfigError.message}`);
    }
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);

    // Table assistant_configs (agent ElevenLabs)
    const { error: assistantConfigError } = await supabase.from("assistant_configs").update({
      twilio_number:         purchasedNumber.phoneNumber,
      elevenlabs_agent_id:   newAgent.agent_id,
      updated_at:            new Date().toISOString(),
    }).eq("company_id", companyId);
    if (assistantConfigError) {
      throw new Error(`Sauvegarde assistant : ${assistantConfigError.message}`);
    }
    lockStartedAt = await renewProvisioningLock(companyId, lockStartedAt);

    // Table phone_numbers (routing multi-tenant)
    results.phoneNumberPersistenceAttempted = true;
    results.resourceOwnershipToken = lockStartedAt;
    const { error: phoneNumberError } = await supabase.from("phone_numbers").upsert({
      phone_number:              purchasedNumber.phoneNumber,
      company_id:                companyId,
      elevenlabs_agent_id:       newAgent.agent_id,
      elevenlabs_phone_number_id: importedNumber.phone_number_id,
      twilio_phone_sid:          purchasedNumber.sid,
      status:                    "active",
      created_at:                new Date().toISOString(),
      updated_at:                results.resourceOwnershipToken,
    }, { onConflict: "phone_number" });
    if (phoneNumberError) {
      throw new Error(`Sauvegarde numéro : ${phoneNumberError.message}`);
    }

    const finalized = await finalizeProvisioningLock(
      companyId,
      lockStartedAt,
      "done"
    );
    if (!finalized) throw provisioningLockLostError();
    lockStartedAt = null;

    log.push("Provisioning terminé avec succès !");

    return {
      success: true,
      phone_number:             purchasedNumber.phoneNumber,
      twilio_phone_sid:         purchasedNumber.sid,
      elevenlabs_agent_id:      newAgent.agent_id,
      elevenlabs_phone_id:      importedNumber.phone_number_id,
      agent_id:                 newAgent.agent_id,
      log,
    };

  } catch (err) {
    log.push(`ERREUR : ${err.message}`);
    console.error("[provision] Erreur:", err);

    // Retirer d'abord les références DB de cette tentative, sans écraser
    // une éventuelle nouvelle tentative ayant déjà pris le verrou.
    const { resourcesAdopted } = await rollbackPersistedConfig(
      companyId,
      results,
      log
    );

    // Rollback en ordre inverse de création. Chaque étape continue même si
    // une autre échoue afin de libérer le maximum de ressources.
    if (!resourcesAdopted && results.elevenLabsPhoneNumberId) {
      try {
        await elDelete(
          `/v1/convai/phone-numbers/${results.elevenLabsPhoneNumberId}`
        );
        log.push(
          `Rollback : numéro ElevenLabs ${results.elevenLabsPhoneNumberId} supprimé`
        );
      } catch (rbErr) {
        log.push(
          `Rollback ElevenLabs phone échoué : ${rbErr.message}`
          + ` — supprimer manuellement ${results.elevenLabsPhoneNumberId}`
        );
      }
    }

    if (!resourcesAdopted && results.elevenLabsAgentId) {
      try {
        await elDelete(`/v1/convai/agents/${results.elevenLabsAgentId}`);
        log.push(
          `Rollback : agent ElevenLabs ${results.elevenLabsAgentId} supprimé`
        );
      } catch (rbErr) {
        log.push(
          `Rollback agent ElevenLabs échoué : ${rbErr.message}`
          + ` — supprimer manuellement ${results.elevenLabsAgentId}`
        );
      }
    }

    if (!resourcesAdopted && results.twilioPhoneSid) {
      try {
        await twilioClient.incomingPhoneNumbers(results.twilioPhoneSid).remove();
        log.push(`Rollback : numéro Twilio ${results.twilioPhoneNumber} libéré`);
      } catch (rbErr) {
        log.push(`Rollback échoué : ${rbErr.message} — libérer manuellement ${results.twilioPhoneSid}`);
      }
    }

    if (lockStartedAt) {
      try {
        const finalized = await finalizeProvisioningLock(
          companyId,
          lockStartedAt,
          "failed",
          err.message
        );
        if (!finalized) {
          log.push(
            "État failed non écrit : le verrou appartient à une nouvelle tentative"
          );
        }
      } catch (lockError) {
        log.push(`Finalisation du verrou échouée : ${lockError.message}`);
      }
    }

    return { success: false, error: err.message, log };
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS ElevenLabs API
// ─────────────────────────────────────────────────────────────
async function elevenLabsGet(path) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    headers: { "xi-api-key": ELEVENLABS_KEY },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs GET impossible (${res.status})`);
  }
  return res.json();
}

async function elevenLabsPost(path, body) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs POST impossible (${res.status})`);
  }
  return res.json();
}

async function elevenLabsPatch(path, body) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    method: "PATCH",
    headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs PATCH impossible (${res.status})`);
  }
  return res.json();
}

async function elDelete(path) {
  const res = await fetch(`${ELEVENLABS_API}${path}`, {
    method: "DELETE",
    headers: { "xi-api-key": ELEVENLABS_KEY },
  });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`ElevenLabs DELETE impossible (${res.status})`);
  }

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
