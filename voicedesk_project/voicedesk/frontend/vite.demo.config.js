import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import base from "./vite.config.js";

// Only this explicitly selected local config replaces authentication/API.
// Production App.jsx, AuthContext and the standard Vite config are untouched.
export default defineConfig(({ command }) => {
  if (command !== "serve") throw new Error("La démo est réservée au serveur local, pas au déploiement.");
  const config = mergeConfig(base, {
    cacheDir: ".demo-vite-cache",
    define: { "import.meta.env.VITE_API_URL": JSON.stringify("") },
    plugins: [{
      name: "voicedesk-explicit-local-demo",
      enforce: "pre",
      resolveId(source) {
        if (source.replaceAll("\\", "/").endsWith("/contexts/AuthContext.jsx")) {
          return fileURLToPath(new URL("./demo/AuthContext.jsx", import.meta.url));
        }
      },
      transform(code, id) {
        if (id.replaceAll("\\", "/").endsWith("/pages/Dashboard.jsx")) {
          return code.replace("Activité réelle de votre assistante IA, sans données de démonstration.",
            "Données fictives de démonstration — aucune activité réelle.");
        }
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // No fallback to a real backend, even for unmocked browser requests.
          if (/^\/(api|webhooks)(\/|$)/.test(req.url || "")) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Démo locale : aucun backend réel n'est connecté." }));
            return;
          }
          next();
        });
      },
    }],
    server: {
      host: "127.0.0.1", port: 3000, strictPort: true, allowedHosts: ["localhost", "127.0.0.1"],
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'none'; form-action 'self'; base-uri 'self'",
      },
    },
  });
  config.server.proxy = {};
  config.server.hmr = false;
  return config;
});
