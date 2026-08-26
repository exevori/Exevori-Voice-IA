import assert from "node:assert/strict";
import { test } from "node:test";

import { mapImportField, normalizeImportHeader } from "./importMapping.js";

test("les en-têtes accentués et espacés sont normalisés", () => {
  assert.equal(normalizeImportHeader(" Numéro de téléphone "), "numero_de_telephone");
  assert.equal(normalizeImportHeader("FULL-NAME"), "full_name");
});

test("company_name ne peut pas voler la valeur de full_name", () => {
  const row = {
    company_name: "Exemple inc.",
    phone: "+14185550123",
    full_name: "Marie Tremblay",
  };
  assert.equal(
    mapImportField(row, "full_name", "full name", "nom", "name"),
    "Marie Tremblay"
  );
  assert.equal(
    mapImportField(row, "company_name", "company name", "company"),
    "Exemple inc."
  );
});

test("le fallback accepte un alias descriptif mais pas name en sous-chaîne", () => {
  assert.equal(
    mapImportField({ telephone_principal: "+14185550123" }, "telephone"),
    "+14185550123"
  );
  assert.equal(mapImportField({ company_name: "Exemple" }, "name"), null);
});
