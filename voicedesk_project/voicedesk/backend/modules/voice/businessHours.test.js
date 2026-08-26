import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BusinessHoursConfigurationError,
  canonicalizeBusinessHours,
  evaluateBusinessHours,
  normalizeBusinessHours,
} from "./businessHours.js";

const WEEKDAYS = {
  monday: { open: "09:00", close: "17:00" },
  tuesday: { open: "09:00", close: "17:00" },
  wednesday: { open: "09:00", close: "17:00" },
  thursday: { open: "09:00", close: "17:00" },
  friday: { open: "09:00", close: "17:00" },
  saturday: null,
  sunday: null,
};

test("ISO day keys 1=Monday through 7=Sunday are accepted", () => {
  const schedule = normalizeBusinessHours({
    1: [{ start: "09:00", end: "17:00" }],
    7: { open: "10:00", close: "12:00" },
  });

  assert.deepEqual(schedule.monday, [{ start: 540, end: 1020 }]);
  assert.deepEqual(schedule.sunday, [{ start: 600, end: 720 }]);
});

test("named and ISO definitions for the same day are rejected", () => {
  assert.throws(
    () => normalizeBusinessHours({
      monday: { open: "09:00", close: "17:00" },
      1: { open: "10:00", close: "18:00" },
    }),
    error => error?.code === "ambiguous_business_hours"
  );
});

test("la forme persistée est canonique, bornée et réutilisable", () => {
  const stored = canonicalizeBusinessHours({
    monday: { open: "09:15", close: "17:30" },
    ignored: [{ start: "00:00", end: "23:59" }],
    "7": [{ start: "22:00", end: "24:00" }],
  });

  assert.deepEqual(stored["1"], [{ start: "09:15", end: "17:30" }]);
  assert.deepEqual(stored["7"], [{ start: "22:00", end: "24:00" }]);
  assert.equal("ignored" in stored, false);
  assert.deepEqual(canonicalizeBusinessHours(stored), stored);
  assert.equal(canonicalizeBusinessHours(null), null);
});

test("les bornes sont ouverture incluse et fermeture exclue", () => {
  const atOpening = evaluateBusinessHours({
    now: "2026-01-05T14:00:00Z",
    timeZone: "America/Toronto",
    businessHours: WEEKDAYS,
  });
  const atClosing = evaluateBusinessHours({
    now: "2026-01-05T22:00:00Z",
    timeZone: "America/Toronto",
    businessHours: WEEKDAYS,
  });

  assert.equal(atOpening.isOpen, true);
  assert.equal(atClosing.isOpen, false);
  assert.equal(atClosing.nextOpenLabel, "demain à 9 h");
});

test("les plages fractionnées et nocturnes sont acceptées", () => {
  const schedule = {
    monday: [
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
      { start: "22:00", end: "02:00" },
    ],
  };

  assert.equal(evaluateBusinessHours({
    now: "2026-01-05T17:30:00Z",
    timeZone: "America/Toronto",
    businessHours: schedule,
  }).isOpen, false);
  assert.equal(evaluateBusinessHours({
    now: "2026-01-06T06:00:00Z",
    timeZone: "America/Toronto",
    businessHours: schedule,
  }).isOpen, true);
  assert.equal(evaluateBusinessHours({
    now: "2026-01-06T08:00:00Z",
    timeZone: "America/Toronto",
    businessHours: schedule,
  }).isOpen, false);
});

test("le prochain horaire saute les jours fermés", () => {
  const result = evaluateBusinessHours({
    now: "2026-01-09T23:00:00Z",
    timeZone: "America/Toronto",
    businessHours: WEEKDAYS,
  });

  assert.equal(result.isOpen, false);
  assert.equal(result.nextOpenLabel, "lundi à 9 h");
});

test("un même instant est évalué dans le fuseau propre au tenant", () => {
  const instant = "2026-01-05T15:30:00Z";
  const toronto = evaluateBusinessHours({
    now: instant,
    timeZone: "America/Toronto",
    businessHours: WEEKDAYS,
  });
  const vancouver = evaluateBusinessHours({
    now: instant,
    timeZone: "America/Vancouver",
    businessHours: WEEKDAYS,
  });

  assert.equal(toronto.isOpen, true);
  assert.equal(vancouver.isOpen, false);
  assert.equal(vancouver.nextOpenLabel, "aujourd'hui à 9 h");
});

test("le passage à l'heure avancée utilise l'heure locale IANA", () => {
  const schedule = { sunday: { open: "03:00", close: "04:00" } };
  const beforeJump = evaluateBusinessHours({
    now: "2026-03-08T06:30:00Z",
    timeZone: "America/Toronto",
    businessHours: schedule,
  });
  const afterJump = evaluateBusinessHours({
    now: "2026-03-08T07:30:00Z",
    timeZone: "America/Toronto",
    businessHours: schedule,
  });

  assert.equal(beforeJump.localMinute, 90);
  assert.equal(beforeJump.isOpen, false);
  assert.equal(afterJump.localMinute, 210);
  assert.equal(afterJump.isOpen, true);
});

test("les deux occurrences de l'heure répétée restent ouvertes", () => {
  const schedule = { sunday: { open: "01:00", close: "02:00" } };
  for (const instant of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
    const result = evaluateBusinessHours({
      now: instant,
      timeZone: "America/Toronto",
      businessHours: schedule,
    });
    assert.equal(result.localMinute, 90);
    assert.equal(result.isOpen, true);
  }
});

test("une absence d'horaire conserve le comportement actuel", () => {
  assert.deepEqual(evaluateBusinessHours({ businessHours: null }), {
    configured: false,
    isOpen: true,
    nextOpen: null,
    nextOpenLabel: null,
  });
});

test("un fuseau ou un horaire invalide échoue explicitement", () => {
  assert.throws(
    () => evaluateBusinessHours({
      timeZone: "Canada/Imaginaire",
      businessHours: WEEKDAYS,
    }),
    BusinessHoursConfigurationError
  );
  assert.throws(
    () => evaluateBusinessHours({
      timeZone: "America/Toronto",
      businessHours: { monday: { open: "9:00", close: "17:00" } },
    }),
    BusinessHoursConfigurationError
  );
});
