import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  RECORDING_CONSENT_NOTICE_FR,
  RECORDING_CONSENT_SYSTEM_RULE_FR,
  escapeXmlAttribute,
  findConsentTerminationToolName,
  hasConsentTerminationCapability,
  isRecordingConsentRefusal,
  prefixConsentSystemRuleFr,
  prefixRecordingConsentFr,
} from "./consent.js";

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

test("l'annonce française contient toutes les informations obligatoires", () => {
  assert.match(RECORDING_CONSENT_NOTICE_FR, /assistante virtuelle/i);
  assert.match(RECORDING_CONSENT_NOTICE_FR, /intelligence artificielle/i);
  assert.match(RECORDING_CONSENT_NOTICE_FR, /enregistré/i);
  assert.match(RECORDING_CONSENT_NOTICE_FR, /transcrit/i);
  assert.match(RECORDING_CONSENT_NOTICE_FR, /suivi|qualité/i);
  assert.match(RECORDING_CONSENT_NOTICE_FR, /refuser/i);
});

test("le helper préfixe l'annonce exactement une fois", () => {
  const first = prefixRecordingConsentFr(
    "Je suis Léa. Comment puis-je vous aider?"
  );
  const second = prefixRecordingConsentFr(first);

  assert.ok(first.startsWith(RECORDING_CONSENT_NOTICE_FR));
  assert.equal(second, first);
  assert.equal(occurrences(second, RECORDING_CONSENT_NOTICE_FR), 1);
});

test("le helper replace une annonce existante au début sans la dupliquer", () => {
  const input =
    `Je suis Léa. ${RECORDING_CONSENT_NOTICE_FR} Comment puis-je vous aider?`;
  const result = prefixRecordingConsentFr(input);

  assert.ok(result.startsWith(RECORDING_CONSENT_NOTICE_FR));
  assert.equal(occurrences(result, RECORDING_CONSENT_NOTICE_FR), 1);
});

test("la règle système prioritaire encadre un refus sans fausse promesse", () => {
  assert.match(RECORDING_CONSENT_SYSTEM_RULE_FR, /prioritaire/i);
  assert.match(RECORDING_CONSENT_SYSTEM_RULE_FR, /ne la répète pas/i);
  assert.match(RECORDING_CONSENT_SYSTEM_RULE_FR, /cesse immédiatement/i);
  assert.match(RECORDING_CONSENT_SYSTEM_RULE_FR, /ne prétends jamais/i);
  assert.match(RECORDING_CONSENT_SYSTEM_RULE_FR, /transfert|mettre fin/i);
});

test("la règle système est ajoutée une seule fois avant le prompt client", () => {
  const clientPrompt = "Tu es Léa. Réponds brièvement.";
  const first = prefixConsentSystemRuleFr(clientPrompt);
  const second = prefixConsentSystemRuleFr(first);

  assert.ok(first.startsWith(RECORDING_CONSENT_SYSTEM_RULE_FR));
  assert.ok(first.endsWith(clientPrompt));
  assert.equal(second, first);
  assert.equal(occurrences(second, RECORDING_CONSENT_SYSTEM_RULE_FR), 1);
});

test("une annonce injectée dans TwiML est échappée comme attribut XML", () => {
  assert.equal(
    escapeXmlAttribute('Léa & "Équipe" <Exevori>'),
    "Léa &amp; &quot;Équipe&quot; &lt;Exevori&gt;"
  );
});

test("le refus d'enregistrement est détecté sans confondre un refus commercial", () => {
  for (const phrase of [
    "Je refuse l'enregistrement.",
    "Arrêtez de transcrire cet appel.",
    "Ne m'enregistrez pas.",
    "N'enregistrez pas cet appel.",
    "Pas d'enregistrement s'il vous plaît.",
    "Je ne veux pas être enregistré.",
    "Je veux pas être enregistré.",
    "J'veux pas être enregistré.",
    "Enregistrez pas cet appel.",
    "Veuillez ne pas enregistrer cet appel.",
    "Je préfère ne pas être enregistré.",
    "Je m'oppose à la transcription.",
    "Je veux que vous arrêtiez l'enregistrement.",
    "On continue sans enregistrement.",
    "Je ne souhaite pas que cet appel soit enregistré.",
    "Je ne vous autorise pas à enregistrer cet appel.",
    "Je ne donne pas mon consentement à l'enregistrement.",
    "Vous n'avez pas mon consentement pour la transcription.",
    "Je retire mon consentement à la transcription.",
    "I do not consent to AI processing.",
    "Please don't record me.",
    "I don't want this call recorded.",
    "I do not authorize you to record this call.",
    "You don't have my permission to transcribe this call.",
    "I object to this call being recorded.",
    "I'd rather not be recorded.",
    "I haven't consented to the transcription.",
    "No recording, please.",
    "I withdraw my consent to AI processing.",
  ]) {
    assert.equal(isRecordingConsentRefusal(phrase), true);
  }
  for (const phrase of [
    "Je refuse votre offre commerciale.",
    "Je ne veux pas acheter ce produit.",
    "Je ne souhaite pas recevoir votre offre.",
    "Je ne vous autorise pas à me rappeler.",
    "Arrêtez de me vendre cette assurance.",
    "I don't want your service.",
    "I do not authorize this purchase.",
    "No appointment, please.",
  ]) {
    assert.equal(isRecordingConsentRefusal(phrase), false);
  }
  assert.equal(
    isRecordingConsentRefusal("Je refuse", { allowBareRefusal: true }),
    true
  );
  assert.equal(isRecordingConsentRefusal("Je refuse"), false);
});

test("la capacité déterministe de fin d'appel est détectée", () => {
  const tools = [
    {
      type: "function",
      function: { name: "end_call", parameters: { type: "object" } },
    },
  ];
  assert.equal(findConsentTerminationToolName(tools), "end_call");
  assert.equal(findConsentTerminationToolName([]), null);
  assert.equal(
    hasConsentTerminationCapability({
      workflow: {
        nodes: {
          finish: { type: "end" },
        },
      },
    }),
    false
  );
  assert.equal(
    hasConsentTerminationCapability({
      conversation_config: {
        agent: {
          prompt: {
            tools: [{ params: { system_tool_type: "end_call" } }],
          },
        },
      },
    }),
    true
  );
  assert.equal(hasConsentTerminationCapability({ type: "tool" }), false);
});

test("le Custom LLM force end_call avant toute lecture tenant en cas de refus", () => {
  const source = fs.readFileSync(
    new URL("../elevenlabs/index.js", import.meta.url),
    "utf8"
  );
  const refusalIndex = source.indexOf("isRecordingConsentRefusal(");
  const tenantIndex = source.indexOf("extractCustomLlmTenantHints(req)");

  assert.ok(refusalIndex >= 0);
  assert.ok(tenantIndex > refusalIndex);
  assert.ok(source.includes("findConsentTerminationToolName(body.tools)"));
  assert.ok(source.includes('writeChunk({}, "tool_calls")'));
  assert.ok(source.includes("Consent termination unavailable"));
});
