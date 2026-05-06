# E2EUSER Baseline-Shape Spec v1.0

**Status:** RATIFIED 2026-05-06T19:23 UTC (Quinn arbitration on Sarah v0.1)
**Owner:** Sarah (TT FE contract author) → Fulton (impl)
**Consumers:** `reset-test-user`, `elevate-test-user-role` (TEST-mutator endpoints, per ADR-0017)
**Companion fixture:** `baseline/manifest.json` (events + organizer; commit `0153a2b`)
**Companion registry:** `baseline/test-users.json` (UID registry, Fulton-populated; one-time mint, idempotent)

## Architecture frame

- Signup-flow IS the test (real TT app path: `/auth/signup`) — Toby 16:07 lock.
- E2EUSER spec = "what reset puts user back to BETWEEN UCs" — NOT "what to pre-seed in Firebase."
- `emailVerified` handled programmatically by `elevate-test-user-role` (Option b, idempotent stamp on every elevation call).

## TT FE bootstrap contract (grounding)

- Endpoint: `GET /api/userlogins/firebase/{firebaseUid}?appId=99` with Bearer token
- FE reads: `roleIds[]` (populated objects with `_id`, `roleName`, `appId`), `regionalOrganizerInfo`, `regionalAdminInfo`, `localUserInfo`
- Default role selection: prefers `NamedUser`; falls back to first role; `AnonymousUser` only on bootstrap fail (minimal user)
- AppId-scoped role filter prevents cross-app role leak (per TIEMPO-430)
- Source: `tangotiempo.com/src/app/contexts/AuthContext.js:148-211`

## Hybrid pattern (RATIFIED)

### Pattern A — "mint-once, reset-MongoDB-only" (DEFAULT COHORT)

- Single persistent Firebase user: `tango.tiempo.test@gmail.com`
- UID minted once, captured to `baseline/test-users.json`
- `reset-test-user` resets MongoDB userLogins doc only; Firebase untouched
- Used by: all non-signup UCs (filter / nav / role-aware-non-bootstrap / explore-mode / list-view)

### Pattern B — "ephemeral per-correlation" (UC-0002 SIGNUP ONLY)

- Fresh Firebase user per spawn via Gmail aliasing: `tango.tiempo.test+{correlationId}@gmail.com`
- Cleanup endpoint (NEW, queued for UC-0002 spec authoring — Story 2.2 task): `delete-test-user-by-correlation`
- Used by: UC-0002 signup-flow only

## Reset-to-NU baseline shape (Pattern A; MongoDB userLogins doc)

```json
{
  "_testFixtureKey": "E2EUSER",
  "appId": 99,
  "firebaseUserId": "<resolved from baseline/test-users.json[E2EUSER].firebaseUid>",
  "roleIds": ["<NamedUser ObjectId for appId=99 — resolve-by-name>"],
  "regionalOrganizerInfo": {
    "organizerId": null,
    "isActive": false,
    "isEnabled": false,
    "isApproved": false
  },
  "regionalAdminInfo": {
    "regionAdminId": null,
    "isActive": false
  },
  "localUserInfo": {
    "displayName": "E2E Test User",
    "email": "tango.tiempo.test@gmail.com"
  },
  "active": true
}
```

## Resolution logic (Pattern A)

- `firebaseUserId` resolution: read `baseline/test-users.json[E2EUSER].firebaseUid`
- `roleIds[0]` resolution: lookup `roleNameCode = "NU"` (or `roleName = "NamedUser"`) where `appId = 99` in `roles` collection → `_id` (mirrors manifest's resolve-by-name pattern for organizers/categories/cities)
- All other fields static per spec

## UID-mint authority (Pattern A bootstrap)

Fulton lane. First-run setup logic (idempotent, re-runnable) within `reset-test-user` impl OR separate bootstrap script:

1. Check Firebase for `tango.tiempo.test@gmail.com` user (Admin SDK `getUserByEmail`)
2. If not exists: Admin SDK `createUser({ email, password: <env var TEST_USER_PWD>, emailVerified: true })` → capture UID
3. If exists: read UID from Admin SDK lookup
4. Persist UID to `baseline/test-users.json[E2EUSER].firebaseUid` (idempotent overwrite, file checked into test-mutators repo)

Note: the Toby Firebase email + Gmail temp pwd item closed structurally 18:00 (signup-flow UC creates user via real app path). Pattern A's Firebase user is now Fulton-minted on first reset-test-user fire — no Toby-direct credentials needed, no pre-create relay, no Gmail temp-pwd dependency.

## Q ratifications (RATIFIED Quinn 19:23)

| Q | Topic | Decision | Source |
|---|---|---|---|
| Q1 | Firebase UID lifecycle | Hybrid Pattern A+B | Sarah recommendation accepted |
| Q2 | Default role state for reset | `NamedUser` (NU) | AuthContext.js:204-212 (NU is post-signup default + FE-preferred) |
| Q3 | Default organizer membership | None (`organizerId: null`, all flags `false`) | AuthContext.js:165-178 (RO requires populated `regionalOrganizerInfo`) |
| Q4 | emailVerified default | `true` steady state, no reset action | Option-b stamp persists across resets in Pattern A |

## Cross-app coordination (parking)

Cord (HJ appId=2) will need parallel spec for HJ-side cohort. Suggested shape: identical structure, swap `appId: 2`, separate `firebaseUserId` (different Firebase user, e.g. `harmony.junction.test@gmail.com`). Hand-off via Quinn-as-relay when Cord's cohort fires (Phase I prep). Non-blocking now.

## Downstream coupling

- `reset-test-user` endpoint: consumes Pattern A
- `elevate-test-user-role` endpoint: receives request to elevate from NU → RO / RA; stamps `emailVerified=true` side-effect (Option b)
- UC-0002 signup-flow test: consumes Pattern B (separate flow when Story 2.2 specs)
- Story 2.3 role-elevation matrix (Sarah + Dash): defines NU→RO and NU→RA transition shapes; uses Pattern A user as starting state

## Change log

- v0.1 (2026-05-06T19:20 UTC) — Sarah initial draft (TT FE contract grounded)
- v1.0 (2026-05-06T19:23 UTC) — Quinn ratified Q1-Q4 + reset-to-NU shape; promoted to operative
