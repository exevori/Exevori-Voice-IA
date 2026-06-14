// ============================================================
// Node v20 polyfill : @supabase/realtime-js exige globalThis.WebSocket.
// Ce fichier DOIT être importé en PREMIER dans index.js (avant tout
// module qui instancie un SupabaseClient, ex: middleware/auth.js).
// ============================================================
import { WebSocket } from "ws";

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket;
}
