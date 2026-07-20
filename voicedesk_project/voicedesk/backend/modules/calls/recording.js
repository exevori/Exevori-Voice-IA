// ============================================================
// EXEVORI VOICE IA — Endpoint écoute des enregistrements
// Fichier : backend/modules/calls/recording.js
//
// À monter dans backend/index.js APRÈS callsRouter :
//   import { recordingRouter } from "./modules/calls/recording.js";
//   app.use("/api/v1/calls", requireAuth, enforceTenantOwnership, recordingRouter);
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";

const router   = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const EL_KEY   = process.env.ELEVENLABS_API_KEY;
const EL_BASE  = "https://api.elevenlabs.io";

// GET /api/v1/calls/:id/recording
// Proxy streaming MP3 depuis ElevenLabs → client
router.get("/:id/recording", async (req, res) => {
  const { id }      = req.params;
  const companyId   = req.user?.company_id;

  if (!EL_KEY) return res.status(503).json({ error: "ELEVENLABS_API_KEY non configuré" });

  const { data: call, error } = await supabase
    .from("calls")
    .select("id, company_id, external_id, caller_name")
    .eq("id", id)
    .eq("company_id", companyId) // isolation tenant
    .single();

  if (error || !call) return res.status(404).json({ error: "Appel introuvable" });
  if (!call.external_id) return res.status(404).json({ error: "no_recording", message: "Aucun enregistrement pour cet appel" });

  let elRes;
  try {
    elRes = await fetch(`${EL_BASE}/v1/convai/conversations/${call.external_id}/audio`, {
      headers: { "xi-api-key": EL_KEY },
    });
  } catch {
    return res.status(502).json({ error: "Impossible de joindre ElevenLabs" });
  }

  if (elRes.status === 404)
    return res.status(404).json({ error: "no_recording", message: "Enregistrement non disponible" });
  if (!elRes.ok)
    return res.status(502).json({ error: `ElevenLabs ${elRes.status}` });

  res.setHeader("Content-Type",        elRes.headers.get("content-type") || "audio/mpeg");
  res.setHeader("Accept-Ranges",       "bytes");
  res.setHeader("Content-Disposition", `inline; filename="appel-${call.caller_name || id}.mp3"`);
  const len = elRes.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);

  // Streaming avec backpressure
  const reader = elRes.body.getReader();
  const pump   = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const ok = res.write(value);
        if (!ok) await new Promise(r => res.once("drain", r));
      }
    } catch { res.end(); }
  };
  pump();
});

export { router as recordingRouter };
