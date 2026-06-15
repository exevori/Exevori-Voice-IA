// ============================================================
// EXEVORI VOICE IA — MODULE KB (Phase KB+A)
//
// Routes :
//   POST   /api/v1/kb/sources/upload    multipart file → extract → chunk → store
//   POST   /api/v1/kb/sources/scrape    { url } → fetch → extract → chunk → store
//   GET    /api/v1/kb/sources?company_id=...
//   GET    /api/v1/kb/sources/:id       → metadata + chunks
//   DELETE /api/v1/kb/sources/:id       → cascade delete chunks + storage object
//
// Tables : knowledge_sources, knowledge_chunks
// Bucket : kb-uploads
// ============================================================

import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { convert as htmlToText } from "html-to-text";
import { encode as gptEncode } from "gpt-tokenizer";

import { embedChunksOfSource, searchSimilarChunks, embedText } from "./rag.js";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// ─────────────────────────────────────────────────────────────
// POST /upload
// multipart: file, company_id
// ─────────────────────────────────────────────────────────────
router.post("/sources/upload", upload.single("file"), async (req, res) => {
  const { company_id, created_by } = req.body;
  const file = req.file;
  if (!company_id || !file) return res.status(400).json({ error: "company_id et file requis" });

  const mime = file.mimetype;
  const allowedMimes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
    "text/markdown",
    "text/x-markdown",
  ];
  if (!allowedMimes.includes(mime)) {
    return res.status(400).json({ error: `Type de fichier non supporté : ${mime}` });
  }

  // 1. Créer la source en status=processing
  const { data: source, error: sErr } = await supabase
    .from("knowledge_sources")
    .insert({
      company_id,
      type: "upload",
      name: file.originalname,
      mime_type: mime,
      size_bytes: file.size,
      status: "processing",
      created_by: created_by || null,
    })
    .select()
    .single();
  if (sErr) return res.status(500).json({ error: sErr.message });

  // 2. Upload du fichier dans le bucket
  const storagePath = `${company_id}/${source.id}/${sanitizeFilename(file.originalname)}`;
  const { error: upErr } = await supabase.storage
    .from("kb-uploads")
    .upload(storagePath, file.buffer, { contentType: mime, upsert: false });
  if (upErr) {
    await supabase.from("knowledge_sources").update({
      status: "error",
      error_message: `upload: ${upErr.message}`,
    }).eq("id", source.id);
    return res.status(500).json({ error: upErr.message });
  }
  await supabase.from("knowledge_sources").update({ storage_path: storagePath }).eq("id", source.id);

  // 3. Extraction du texte
  let text = "";
  try {
    text = await extractText(file.buffer, mime, file.originalname);
  } catch (e) {
    await supabase.from("knowledge_sources").update({
      status: "error",
      error_message: `extract: ${e.message}`,
    }).eq("id", source.id);
    return res.status(500).json({ error: `Extraction échouée : ${e.message}` });
  }

  // 4. Chunking + insertion
  const result = await ingestChunks({ company_id, source_id: source.id, text });
  if (result.error) {
    await supabase.from("knowledge_sources").update({
      status: "error",
      error_message: `chunk: ${result.error}`,
    }).eq("id", source.id);
    return res.status(500).json({ error: result.error });
  }

  await supabase.from("knowledge_sources").update({
    status: "ready",
    chunks_count: result.chunks_count,
  }).eq("id", source.id);

  // KB+B — Embeddings (best-effort: si fail, source reste 'ready' mais sans embeddings,
  // l'utilisateur pourra cliquer "Re-embed" plus tard).
  let embeddings_ready_at = null;
  try {
    const emb = await embedChunksOfSource({ source_id: source.id, company_id });
    embeddings_ready_at = emb.embeddings_ready_at;
  } catch (e) {
    console.warn(`[KB] embed upload source=${source.id}:`, e.message);
  }

  return res.json({
    success: true,
    source: { ...source, status: "ready", chunks_count: result.chunks_count, storage_path: storagePath, embeddings_ready_at },
    chunks_count: result.chunks_count,
    text_chars: text.length,
    embeddings_ready: !!embeddings_ready_at,
  });
});

// ─────────────────────────────────────────────────────────────
// POST /sources/scrape
// body: { company_id, url, created_by? }
// ─────────────────────────────────────────────────────────────
router.post("/sources/scrape", express.json(), async (req, res) => {
  const { company_id, url, created_by } = req.body;
  if (!company_id || !url) return res.status(400).json({ error: "company_id et url requis" });

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { return res.status(400).json({ error: "URL invalide" }); }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: "URL doit être http(s)" });
  }

  const { data: source, error: sErr } = await supabase
    .from("knowledge_sources")
    .insert({
      company_id,
      type: "url",
      name: parsedUrl.hostname + parsedUrl.pathname,
      url,
      status: "processing",
      created_by: created_by || null,
    })
    .select()
    .single();
  if (sErr) return res.status(500).json({ error: sErr.message });

  let text = "";
  try {
    text = await scrapeUrl(url);
  } catch (e) {
    await supabase.from("knowledge_sources").update({
      status: "error",
      error_message: `scrape: ${e.message}`,
    }).eq("id", source.id);
    return res.status(500).json({ error: `Scraping échoué : ${e.message}` });
  }

  if (text.length < 100) {
    await supabase.from("knowledge_sources").update({
      status: "error",
      error_message: "Contenu < 100 caractères (page 404 ou vide ?)",
    }).eq("id", source.id);
    return res.status(422).json({
      error: "Contenu trop court (< 100 caractères). Vérifiez que l'URL renvoie une vraie page (essayez la racine du site, ex: https://exevori.com).",
    });
  }

  const result = await ingestChunks({ company_id, source_id: source.id, text });
  if (result.error) {
    await supabase.from("knowledge_sources").update({
      status: "error",
      error_message: `chunk: ${result.error}`,
    }).eq("id", source.id);
    return res.status(500).json({ error: result.error });
  }

  await supabase.from("knowledge_sources").update({
    status: "ready",
    chunks_count: result.chunks_count,
    size_bytes: text.length,
  }).eq("id", source.id);

  // KB+B — Embeddings (best-effort, idem upload)
  let embeddings_ready_at = null;
  try {
    const emb = await embedChunksOfSource({ source_id: source.id, company_id });
    embeddings_ready_at = emb.embeddings_ready_at;
  } catch (e) {
    console.warn(`[KB] embed scrape source=${source.id}:`, e.message);
  }

  return res.json({
    success: true,
    source: { ...source, status: "ready", chunks_count: result.chunks_count, size_bytes: text.length, embeddings_ready_at },
    chunks_count: result.chunks_count,
    text_chars: text.length,
    embeddings_ready: !!embeddings_ready_at,
  });
});

// ─────────────────────────────────────────────────────────────
// POST /sources/manual  — Note manuelle (Phase Bonus KB)
//   body: { company_id, name, content, created_by? }
//   → crée une knowledge_sources type='manual', chunke, embed
// ─────────────────────────────────────────────────────────────
router.post("/sources/manual", express.json({ limit: "5mb" }), async (req, res) => {
  const { company_id, name, content, created_by } = req.body || {};
  if (!company_id || !name || !content) {
    return res.status(400).json({ error: "company_id, name et content requis" });
  }
  const cleanText = String(content).trim();
  if (cleanText.length < 30) {
    return res.status(400).json({ error: "Contenu trop court (< 30 caractères)" });
  }
  if (cleanText.length > 200_000) {
    return res.status(400).json({ error: "Contenu trop long (> 200 000 caractères)" });
  }

  const { data: source, error: sErr } = await supabase
    .from("knowledge_sources")
    .insert({
      company_id,
      type: "manual",
      name: String(name).slice(0, 200),
      status: "processing",
      size_bytes: cleanText.length,
      created_by: created_by || null,
    })
    .select()
    .single();
  if (sErr) return res.status(500).json({ error: sErr.message });

  const result = await ingestChunks({ company_id, source_id: source.id, text: cleanText });
  if (result.error) {
    await supabase.from("knowledge_sources").update({
      status: "error", error_message: `chunk: ${result.error}`,
    }).eq("id", source.id);
    return res.status(500).json({ error: result.error });
  }

  await supabase.from("knowledge_sources").update({
    status: "ready",
    chunks_count: result.chunks_count,
  }).eq("id", source.id);

  // Embeddings best-effort
  let embeddings_ready_at = null;
  try {
    const emb = await embedChunksOfSource({ source_id: source.id, company_id });
    embeddings_ready_at = emb.embeddings_ready_at;
  } catch (e) {
    console.warn(`[KB] embed manual source=${source.id}:`, e.message);
  }

  return res.json({
    success: true,
    source: { ...source, status: "ready", chunks_count: result.chunks_count, embeddings_ready_at },
    chunks_count: result.chunks_count,
    embeddings_ready: !!embeddings_ready_at,
  });
});

// ─────────────────────────────────────────────────────────────
// PATCH /chunks/:id  — Édition manuelle d'un chunk (Phase Bonus KB)
//   body: { company_id, content }
//   → met à jour content + re-embed CE chunk uniquement (rapide)
// ─────────────────────────────────────────────────────────────
router.patch("/chunks/:id", express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id, content } = req.body || {};
  if (!company_id || !content) return res.status(400).json({ error: "company_id et content requis" });
  const cleanText = String(content).trim();
  if (cleanText.length < 10)      return res.status(400).json({ error: "Contenu trop court (< 10 caractères)" });
  if (cleanText.length > 50_000)  return res.status(400).json({ error: "Contenu trop long (> 50 000 caractères)" });

  // Sanity check : le chunk existe et appartient au bon tenant
  const { data: chunk, error: cErr } = await supabase
    .from("knowledge_chunks")
    .select("id, company_id, source_id, chunk_index")
    .eq("id", id)
    .maybeSingle();
  if (cErr)                             return res.status(500).json({ error: cErr.message });
  if (!chunk)                           return res.status(404).json({ error: "Chunk introuvable" });
  if (chunk.company_id !== company_id)  return res.status(403).json({ error: "Chunk d'un autre tenant" });

  // Embed nouveau contenu
  let embedding = null;
  try {
    embedding = await embedText(cleanText);
  } catch (e) {
    return res.status(500).json({ error: `Embedding échoué : ${e.message}` });
  }

  // gpt-tokenizer pour le token_count
  const token_count = gptEncode(cleanText).length;

  const { data: updated, error: uErr } = await supabase
    .from("knowledge_chunks")
    .update({ content: cleanText, embedding, token_count })
    .eq("id", id)
    .select("id, chunk_index, content, token_count")
    .single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  // Met à jour le timestamp embeddings_ready_at de la source (puisqu'on a re-embeddé)
  await supabase
    .from("knowledge_sources")
    .update({ embeddings_ready_at: new Date().toISOString() })
    .eq("id", chunk.source_id);

  return res.json({ success: true, chunk: updated });
});

// ─────────────────────────────────────────────────────────────
// GET /sources?company_id=...
// ─────────────────────────────────────────────────────────────
router.get("/sources", async (req, res) => {
  const { company_id, status, limit = 100, offset = 0 } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  let q = supabase.from("knowledge_sources")
    .select("*", { count: "exact" })
    .eq("company_id", company_id)
    .order("created_at", { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
  if (status) q = q.eq("status", status);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ sources: data, total: count });
});

// ─────────────────────────────────────────────────────────────
// GET /sources/:id  → metadata + chunks preview (limit 50)
// ─────────────────────────────────────────────────────────────
router.get("/sources/:id", async (req, res) => {
  const { id } = req.params;
  const { data: source, error } = await supabase
    .from("knowledge_sources").select("*").eq("id", id).maybeSingle();
  if (error)   return res.status(500).json({ error: error.message });
  if (!source) return res.status(404).json({ error: "Source introuvable" });

  const { data: chunks } = await supabase
    .from("knowledge_chunks")
    .select("id, chunk_index, content, token_count")
    .eq("source_id", id)
    .order("chunk_index", { ascending: true })
    .limit(50);

  return res.json({ source, chunks: chunks || [] });
});

// ─────────────────────────────────────────────────────────────
// DELETE /sources/:id  → cascade chunks + storage object
// ─────────────────────────────────────────────────────────────
router.delete("/sources/:id", async (req, res) => {
  const { id } = req.params;
  const { data: source } = await supabase
    .from("knowledge_sources").select("storage_path").eq("id", id).maybeSingle();

  // 1. Delete row → cascade chunks via FK
  const { error } = await supabase.from("knowledge_sources").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  // 2. Delete storage object (best-effort)
  if (source?.storage_path) {
    await supabase.storage.from("kb-uploads").remove([source.storage_path]).catch(() => {});
  }
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// KB+B — POST /sources/search  (widget Knowledge + Phase 8 helper)
// body: { company_id, query, topK?, minSimilarity? }
// ─────────────────────────────────────────────────────────────
router.post("/sources/search", express.json(), async (req, res) => {
  const { company_id, query, topK, minSimilarity } = req.body;
  if (!company_id || !query) {
    return res.status(400).json({ error: "company_id et query requis" });
  }
  try {
    const t0 = Date.now();
    const results = await searchSimilarChunks({
      company_id,
      query,
      topK: Number.isInteger(topK) ? topK : 3,
      minSimilarity: typeof minSimilarity === "number" ? minSimilarity : 0.0,
    });
    return res.json({
      success: true,
      query,
      results,
      latency_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("[KB] /search:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// KB+B — POST /sources/:id/reembed  (régénère embeddings d'une source)
// body: { company_id }
// ─────────────────────────────────────────────────────────────
router.post("/sources/:id/reembed", express.json(), async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  // Sanity check : la source existe et appartient bien à la company
  const { data: source, error: sErr } = await supabase
    .from("knowledge_sources")
    .select("id, company_id, chunks_count, status")
    .eq("id", id)
    .maybeSingle();
  if (sErr)                            return res.status(500).json({ error: sErr.message });
  if (!source)                         return res.status(404).json({ error: "Source introuvable" });
  if (source.company_id !== company_id) return res.status(403).json({ error: "Source d'un autre tenant" });
  if (source.status !== "ready")       return res.status(409).json({ error: `Source en status '${source.status}' (doit être 'ready')` });

  try {
    const t0 = Date.now();
    const result = await embedChunksOfSource({ source_id: id, company_id });
    return res.json({
      success: true,
      embedded_count: result.embedded_count,
      embeddings_ready_at: result.embeddings_ready_at,
      latency_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("[KB] /reembed:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  HELPERS
// ============================================================

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function extractText(buffer, mime, originalName) {
  const name = (originalName || "").toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result?.text || "";
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  // .doc legacy — non supporté nativement, fallback texte
  if (mime === "text/plain" || mime.startsWith("text/") || /\.(txt|md|markdown)$/i.test(name)) {
    return buffer.toString("utf-8");
  }
  throw new Error(`Type non géré : ${mime}`);
}

async function scrapeUrl(url) {
  // Phase 8C-4 : Playwright headless pour gérer les SPAs (React/Vue/Angular).
  // Fallback : raw fetch si Playwright échoue (réseau ou timeout).
  // Timeout total : 25s (load JS + wait DOM idle 1.5s).
  try {
    return await scrapeWithPlaywright(url);
  } catch (e) {
    console.warn(`[KB] Playwright scrape failed (${e.message}). Fallback raw fetch.`);
    return await scrapeWithFetch(url);
  }
}

async function scrapeWithPlaywright(url) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: "ExevoriVoiceIA-KB-Bot/1.0 (+https://exevori.com) Playwright/Chromium",
      viewport: { width: 1366, height: 900 },
      locale: "fr-CA",
    });
    const page = await ctx.newPage();
    // Bloque images/font/media pour scrape plus rapide
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Laisse le SPA hydrater
    try { await page.waitForLoadState("networkidle", { timeout: 5000 }); }
    catch (_) {} // tolère timeout sur sites qui pollent en boucle
    const html = await page.content();
    return cleanHtml(html);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function scrapeWithFetch(url) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ExevoriVoiceIA-KB-Bot/1.0 (+https://exevori.com)",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return cleanHtml(html);
  } finally {
    clearTimeout(timeout);
  }
}

function cleanHtml(html) {
  // 1. cheerio retire scripts/styles/nav/footer
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer,iframe,svg,form,header").remove();
  // Prefer main content
  let root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  const filtered = root.html() || "";

  // 2. html-to-text pour produire du texte propre
  return htmlToText(filtered, {
    wordwrap: false,
    selectors: [
      { selector: "a",   options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  }).replace(/\n{3,}/g, "\n\n").trim();
}

// Chunking : 350 tokens cible, overlap 40 (mémoire contextuelle)
const CHUNK_TARGET = 350;
const CHUNK_OVERLAP = 40;

function chunkText(text) {
  if (!text || !text.trim()) return [];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n\n");
    chunks.push({ content, token_count: gptEncode(content).length });
    // Overlap : retient les derniers paragraphes jusqu'à CHUNK_OVERLAP tokens
    let kept = [];
    let keptTokens = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const t = gptEncode(buffer[i]).length;
      if (keptTokens + t > CHUNK_OVERLAP) break;
      kept.unshift(buffer[i]);
      keptTokens += t;
    }
    buffer = kept;
    bufferTokens = keptTokens;
  };

  for (const para of paragraphs) {
    const tokens = gptEncode(para).length;
    // Paragraphe trop gros tout seul : on le split brutalement
    if (tokens > CHUNK_TARGET * 1.6) {
      flush();
      const words = para.split(/\s+/);
      const stride = Math.ceil(words.length / Math.ceil(tokens / CHUNK_TARGET));
      for (let i = 0; i < words.length; i += stride) {
        const slice = words.slice(i, i + stride).join(" ");
        chunks.push({ content: slice, token_count: gptEncode(slice).length });
      }
      continue;
    }
    if (bufferTokens + tokens > CHUNK_TARGET) flush();
    buffer.push(para);
    bufferTokens += tokens;
  }
  flush();
  return chunks;
}

async function ingestChunks({ company_id, source_id, text }) {
  try {
    const chunks = chunkText(text);
    if (chunks.length === 0) return { error: "Aucun chunk extrait (texte vide ?)" };
    const records = chunks.map((c, i) => ({
      company_id,
      source_id,
      chunk_index: i,
      content: c.content,
      token_count: c.token_count,
    }));
    const { error } = await supabase.from("knowledge_chunks").insert(records);
    if (error) return { error: error.message };
    return { chunks_count: records.length };
  } catch (e) {
    return { error: e.message };
  }
}

export default router;
