import * as cheerio from "cheerio";
import { encode as gptEncode } from "gpt-tokenizer";
import { convert as htmlToText } from "html-to-text";

export const CHUNK_TARGET_TOKENS = 350;
export const CHUNK_OVERLAP_TOKENS = 40;

export function sanitizeFilename(name) {
  return String(name || "document")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

export async function extractText(buffer, mime, originalName) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("document_buffer_required");
  }

  const name = String(originalName || "").toLowerCase();
  const contentType = String(mime || "").toLowerCase();

  if (contentType === "application/pdf" || name.endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result?.text || "";
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (
    contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || name.endsWith(".docx")
  ) {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (
    contentType === "text/plain"
    || contentType.startsWith("text/")
    || /\.(txt|md|markdown)$/i.test(name)
  ) {
    return buffer.toString("utf8");
  }

  throw new Error(`unsupported_document_type:${contentType || "unknown"}`);
}

export function cleanHtml(html) {
  const $ = cheerio.load(String(html || ""));
  $("script,style,noscript,nav,footer,iframe,svg,form,header").remove();
  const root = $("main").length
    ? $("main")
    : $("article").length
      ? $("article")
      : $("body");

  return htmlToText(root.html() || "", {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildQaContent(question, answer) {
  return `Question : ${String(question).trim()}\nRéponse : ${String(answer).trim()}`;
}

export function countTokens(text, encode = gptEncode) {
  return encode(String(text || "")).length;
}

export function chunkText(
  text,
  {
    targetTokens = CHUNK_TARGET_TOKENS,
    overlapTokens = CHUNK_OVERLAP_TOKENS,
    encode = gptEncode,
  } = {}
) {
  if (!String(text || "").trim()) return [];

  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  const chunks = [];
  let buffer = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n\n");
    chunks.push({ content, token_count: encode(content).length });

    const kept = [];
    let keptTokens = 0;
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const count = encode(buffer[index]).length;
      if (keptTokens + count > overlapTokens) break;
      kept.unshift(buffer[index]);
      keptTokens += count;
    }
    buffer = kept;
    bufferTokens = keptTokens;
  };

  for (const paragraph of paragraphs) {
    const tokens = encode(paragraph).length;
    if (tokens > targetTokens * 1.6) {
      flush();
      const words = paragraph.split(/\s+/);
      const sliceSize = Math.max(
        1,
        Math.ceil(words.length / Math.ceil(tokens / targetTokens))
      );
      for (let offset = 0; offset < words.length; offset += sliceSize) {
        const content = words.slice(offset, offset + sliceSize).join(" ");
        chunks.push({ content, token_count: encode(content).length });
      }
      continue;
    }

    if (bufferTokens + tokens > targetTokens) flush();
    buffer.push(paragraph);
    bufferTokens += tokens;
  }

  flush();
  return chunks;
}
