# calendar-be-af-test-mutators

**TEST-tier mutator endpoints for the E2E framework. NEVER deployed to PROD or DEVL.**

Per [[ADR-0017]] (TEST-mutator Function App separation) + [[ADR-0004]] (data isolation).

## Why this lives in a separate repo

Structural separation over process discipline. The PROD `calendar-be-af` deploy pipeline literally cannot include this code because it's not in that repo. Failure-mode asymmetry argument from Quinn 2026-05-06: BE endpoints failing open in PROD = security-incident class. Process discipline drifts; structural separation doesn't.

## 4-Layer Defense-in-Depth

Every mutator endpoint enforces the following gates IN ORDER:

1. **Deploy-gating (structural):** this repo deploys ONLY to `calendarbeaf-test-mutators` Azure Function App on the TEST tier. PROD pipeline has no path to this code.
2. **Function key:** Azure-native, rotatable. Required on every request via `?code=` query param or `x-functions-key` header.
3. **`isE2ETestUser` REJECT-on-no-marker (LOAD-BEARING):** any mutation touching `userlogins` documents MUST verify `isE2ETestUser === true` on the target before any write. Returns 403 `isE2ETestUser_marker_required` otherwise. PROD has zero records with this marker, so endpoints are functionally inert in PROD even if reached.
4. **Optional IP allowlist:** Layer 4 if Azure config supports it; evaluated at Phase B prep.

## Endpoint surface (per ADR-0017 + ADR-0004)

| Endpoint | Purpose |
|---|---|
| `POST /api/test/preset-baseline` | Idempotent baseline staging (`_testCorrelationId: "preset-baseline"`) |
| `POST /api/test/reset-orphans` | correlationId-scoped orphan cleanup per ADR-0004 |
| `POST /api/test/reset-test-user` | Firebase `auth.deleteUser` + Mongo cascade; verifies marker first |
| `POST /api/test/elevate-test-user-role` | userlogins.userRole update; verifies marker first |
| `POST /api/test/seed-with-correlation` | Inline data creation (optional) |

## ADR-0004 correlationId contract

- Format: `${UC_ID}-${unix_ts}-${rand4hex}`, ≤32 chars.
- `_testCorrelationId` field on `appId=99` documents only (sparse).
- Compound index `(appId, _testCorrelationId)`.
- Reserved `preset-baseline` correlationId for shared baseline data.

## Deploy targets

- ✅ TEST tier — `calendarbeaf-test-mutators` Azure Function App
- ❌ DEVL — never
- ❌ PROD — **never**

## Audit log discipline

Every mutation logs: timestamp + caller-IP + endpoint + target-correlationId + target-userId + outcome. Azure Function App standard logs.

## Status

**v0.1.0** — initial scaffold per ADR-0017 ACCEPTED 2026-05-06T17:19. Endpoints stubbed; bodies TBD as Phase B implementation lands.
