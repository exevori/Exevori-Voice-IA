import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQaContent,
  chunkText,
  cleanHtml,
  extractText,
  sanitizeFilename,
} from "./processing.js";

test("text extraction accepts buffers and rejects unsupported binary formats", async () => {
  assert.equal(
    await extractText(Buffer.from("Bonjour VoiceDesk"), "text/plain", "faq.txt"),
    "Bonjour VoiceDesk"
  );
  await assert.rejects(
    () => extractText(Buffer.from([0, 1]), "application/octet-stream", "raw.bin"),
    /unsupported_document_type/
  );
});

test("HTML cleaning keeps business content and removes executable or navigation content", () => {
  const text = cleanHtml(`
    <html><body>
      <nav>Menu secret</nav>
      <main><h1>Heures d'ouverture</h1><p>Lundi à vendredi.</p></main>
      <script>fetch('http://127.0.0.1')</script>
    </body></html>
  `);
  assert.match(text, /Heures d'ouverture/i);
  assert.match(text, /Lundi à vendredi/);
  assert.doesNotMatch(text, /Menu secret|127\.0\.0\.1/);
});

test("chunking is deterministic, bounded and preserves content", () => {
  const encode = value => String(value).split(/\s+/).filter(Boolean);
  const chunks = chunkText(
    "un deux trois quatre\n\ncinq six sept\n\nhuit neuf dix",
    { targetTokens: 6, overlapTokens: 2, encode }
  );
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(chunk => chunk.content && chunk.token_count > 0));
  assert.match(chunks.map(chunk => chunk.content).join(" "), /un deux trois quatre/);
  assert.match(chunks.map(chunk => chunk.content).join(" "), /huit neuf dix/);
});

test("Q&A formatting and storage names are stable", () => {
  assert.equal(buildQaContent("Question?", "Réponse."), "Question : Question?\nRéponse : Réponse.");
  assert.equal(sanitizeFilename("mon dossier/FAQ été.md"), "mon_dossier_FAQ__t_.md");
});
