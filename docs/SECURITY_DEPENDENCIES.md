# Dependency security — September 2026

## Targeted fix for Dependabot alert 56

The alert affects `voicedesk_project/voicedesk/package-lock.json`:

- Before: `concurrently@9.2.1` → `shell-quote@1.8.3`.
- After: `concurrently@9.2.4` → `shell-quote@1.9.0`.
- Both workspace declarations of `concurrently` are pinned to `9.2.4`.
- No runtime dependency, production configuration, or provider credential changes.

The previous lockfile also omitted ten dependencies already declared in the
backend manifest (cheerio, csv-stringify, exceljs, gpt-tokenizer, html-to-text,
imap-simple, mammoth, nodemailer, pdf-parse, pdfkit). `npm install` synchronized
those existing declarations and their dependency trees. Among packages already
present in the lockfile, only concurrently and shell-quote changed version.
No new application capability or third-party service was added.

The update addresses [GHSA-w7jw-789q-3m8p](https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p)
(object-token shell injection) and [GHSA-395f-4hp3-45gv](https://github.com/ljharb/shell-quote/security/advisories/GHSA-395f-4hp3-45gv)
(quadratic parser complexity). Version 1.8.4 alone would not cover the second advisory.

`backend/lib/security-dependencies.test.js` checks rejection of unsafe object
tokens, the environment-callback path, and resolved/locked package versions.
Test payloads are only passed to `parse()` / `quote()`; no payload is executed.

## Verification

Run from `voicedesk_project/voicedesk`:

```powershell
npm ls concurrently shell-quote
node --test backend/lib/security-dependencies.test.js
npm audit --package-lock-only
```

The post-update audit reports **0 critical, 18 high, 10 moderate** package
vulnerabilities. The older incomplete lockfile reported 2 critical, 9 high,
8 moderate; the additional non-critical findings reflect previously unlocked
dependencies now included in the audit. These counts are not directly comparable
as a complete security baseline and will evolve with new advisories.

Run the backend/frontend test suites and frontend build before releasing. An
audit exit code of 1 can still reflect other existing high/moderate advisories;
this targeted change is not a claim that every dependency alert is resolved.
Major runtime upgrades must be reviewed and tested separately, not forced with
`npm audit fix --force`.

GitHub's default-branch alert may remain open while this fix only exists on
`feature/v1-professionnel`. Merge through the approved release process before
expecting the default-branch alert to close. Do not dismiss it as a substitute
for merging the actual fix.
