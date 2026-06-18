// ============================================================
// VOICEDESK IA — MIDDLEWARE enforceTenantOwnership
//
// Cross-tenant data leak prevention.
//
// Le client Supabase utilisé par le backend est instancié avec
// SERVICE_ROLE_KEY → contourne les RLS Postgres. Si un router accepte
// un company_id en body/query/params sans vérifier qu'il correspond
// à req.user.company_id, un user authentifié de la PME A pourrait
// lire/écrire les données de la PME B en truquant le paramètre.
//
// Ce middleware :
//   1. Refuse si req.user absent (devrait déjà être bloqué par requireAuth)
//   2. Bypass si req.user.role === "super_admin" (impersonation légitime)
//   3. Lit le company_id demandé dans : params.company_id, body.company_id,
//      query.company_id (+ variantes camelCase companyId)
//   4. Si présent et ≠ req.user.company_id → 403 Forbidden
//   5. Si absent → laisse passer (la route filtre déjà par req.user.company_id
//      côté business logic — comportement compatible avec l'existant)
//
// Usage :
//   import { enforceTenantOwnership } from "../middleware/enforceTenantOwnership.js";
//   app.use("/api/v1/contacts", requireAuth, enforceTenantOwnership, crmRouter);
// ============================================================

export function enforceTenantOwnership(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Authentification requise",
    });
  }

  // Super admin : passage légitime cross-tenant (impersonation, support)
  if (req.user.role === "super_admin") return next();

  const requestedCompanyId =
    req.params?.company_id ||
    req.params?.companyId ||
    req.body?.company_id ||
    req.body?.companyId ||
    req.query?.company_id ||
    req.query?.companyId;

  // Aucun company_id explicite → la route doit filtrer via req.user.company_id
  // (comportement compatible avec les routers qui ne reçoivent pas ce param).
  if (!requestedCompanyId) return next();

  if (requestedCompanyId !== req.user.company_id) {
    return res.status(403).json({
      error: "forbidden_cross_tenant",
      message: "Accès interdit à cette entreprise (cross-tenant isolation)",
      requested: requestedCompanyId,
      yours: req.user.company_id,
    });
  }

  next();
}

export default enforceTenantOwnership;
