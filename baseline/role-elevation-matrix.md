# Role-Elevation Matrix v1.0 FINAL

**Status:** v1.0 FINAL RATIFIED 2026-05-06T22:43 UTC — Quinn single-round ratify ☑ (cumulative 9-min PRE-FOLD→FINAL arc: 22:33 v0.1 PRE-FOLD → 22:35 Dash arrival → 22:39 Fulton 3-mongosh-probes → 22:42 v1.0 FINAL → 22:43 clean re-issue).
**Owners:** Sarah (TT FE contract) + Dash (CalOps contract); Quinn arbiter; Fulton commits + impls.
**Consumer:** `elevate-test-user-role` (TEST-mutator endpoint, per ADR-0017)
**Companion fixture:** `baseline/manifest.json` schemaVersion 1.1 (commit `b14afdc`)
**Companion spec:** `baseline/e2euser-spec.md` (commit `391f2ad`)

## Architecture frame

- Test-mutator endpoint is **partition-scoped state mutator** (Pattern A: `appId="99"` + `_testFixtureKey`; Pattern B: `appId="1"` + markers `isE2ETestUser` + `_testCorrelationId`), NOT a real-app behavioral test of apply/elevation flows.
- Real-app behavioral testing of apply (TT FE) or admin elevation (CalOps-driven) belongs to dedicated UCs that drive those flows directly.
- `elevate-test-user-role` mirrors **post-state** of either real flow without invoking either.
- Intentional divergence from atomic `/self-apply` (CALBEAF-155 / TIEMPO-441; queued behind M5 + E2E framework).

**Manifest v1.1 prerequisite (commit `b14afdc`):** `roles[]` seed at `appId: "99"` with all 5 codes (NU/SL/RO/RA/SA per Fulton mongosh) and verbatim `permissions[]` from production `appId: "1"`. `_testFixtureKey: "ROLE_<CODE>"` enables resolve-by-key for Pattern A.

**Backend canonical field-name discipline:** Admin sidecar field is `localAdminInfo` on disk (BE canonical, verified Fulton mongosh + code-trace `UserLogins.js:444,475`). CalOps UI presents alias `regionalAdminInfo` (`useUsers.js:85,473-474` performs UI↔BE rename). Test-mutator MUST write `localAdminInfo` on disk; reads via BE GET handler.

## TT FE write paths to userLogins (grounding)

| Path | Use | Source |
|---|---|---|
| `POST /api/userlogins/` | Initial userLogin doc creation post-Firebase-signup | `AuthContext.js:489-530` |
| `PUT /api/userlogins/updateUserInfo` | Profile field updates | `useUserLogins.js:158` |
| `PUT /api/userlogins/{firebaseUserId}/roles` | Role array mutations (apply-as-organizer flow); SET semantics, REPLACES whole `roleIds` array (per Dash `useRoles.js:201`) | `useUserLogins.js:165` |

**Apply-as-organizer flow** (TT FE-driven, NOT CalOps-only): `UserSettingsApply.js`. User clicks Apply → FE bundles `[NU._id, SL._id, RO._id]` + creates organizer record + sets `regionalOrganizerInfo` flags + logs role change.

## Spotlighter context (TT FE knowledge)

- `roleName: "Spotlighter"`, `roleNameCode: "SL"` per Fulton mongosh (DB confirms NU/SL/RO/RA/SA/SO canonical scheme; CalOps `useRoles.js:226-229` SYA/RGA/RGO check is dead code matching no DB doc — Phase B retro cleanup item)
- TIEMPO-431 made Spotlighter "real"; ROLE_DISPLAY_ORDER: `['NamedUser', 'Spotlighter', 'RegionalOrganizer', 'RegionalAdmin', 'SystemAdmin', 'SystemOwner']`
- **No scoping sidecar** for Spotlighter
- **NU+SL+RO retention invariant** (TIEMPO-443, `UserSettingsApply.js:230-232`)

## Transition rows

### NU → Spotlighter (standalone tier; defensive coverage, no current UC)

```json
{
  "roleIds": ["<resolve ROLE_NU>", "<resolve ROLE_SL>"],
  "regionalOrganizerInfo": { "organizerId": null, "isActive": false, "isApproved": false, "isEnabled": false, "allowedMasteredRegionIds": [] },
  "localAdminInfo": { "isActive": false, "isApproved": false, "isEnabled": false, "allowedAdminMasteredRegionIds": [], "allowedAdminMasteredDivisionIds": [], "allowedAdminMasteredCityIds": [] }
}
```

### NU → RO (regional organizer) — Story 2.3 / UC-0003 PRIMARY TRANSITION

```json
{
  "roleIds": ["<resolve ROLE_NU>", "<resolve ROLE_SL>", "<resolve ROLE_RO>"],
  "regionalOrganizerInfo": {
    "organizerId": "<resolve _testFixtureKey: E2EORG (Pattern A) | per-spawn organizer _id (Pattern B)>",
    "isActive": true,
    "isApproved": true,
    "isEnabled": true,
    "allowedMasteredRegionIds": ["<region-objectId>"]
  }
}
```

- **NU+SL retention** per TIEMPO-443
- **All 3 sidecar flags `true` + `allowedMasteredRegionIds` populated** per Dash CalOps `createOrganizer` atomic-3-flag write (`useOrganizerActions.js:87-93`)
- **`isEnabled` actor:** TT FE apply-flow does NOT write `isEnabled` (Sarah verified AuthContext.js:170-178). Real-flow path: TT user applies → BE pending state → CalOps admin acts via `createOrganizer` atomic 3-flag write OR individual toggle (`UserEditForm.js:394-405`). Test-mutator writes all atomically, mirrors `createOrganizer`.
- **Request body shape:** `{ userId, targetRole: "RegionalOrganizer", organizerId, allowedMasteredRegionIds, appId }` — `organizerId` defaults to E2EORG by fixture-key for Pattern A; Pattern B callers MUST provide explicitly (production seeds lack `_testFixtureKey`)

### NU → RA (regional admin)

```json
{
  "roleIds": ["<resolve ROLE_NU>", "<resolve ROLE_RA>"],
  "localAdminInfo": {
    "isActive": true,
    "isApproved": true,
    "isEnabled": true,
    "allowedAdminMasteredRegionIds": ["<region-objectId>"],
    "allowedAdminMasteredDivisionIds": [],
    "allowedAdminMasteredCityIds": []
  }
}
```

- **No SL bundle** — RA is admin-tier orthogonal to content-tier Spotlighter; no TIEMPO-443-equivalent coupling found in CalOps grep
- **3 parallel scoping arrays** (`UserEditForm.js:537-583`, `permissions.js:80-140`):
  - `allowedAdminMasteredRegionIds[]` — region-tier scope
  - `allowedAdminMasteredDivisionIds[]` — division-tier scope
  - `allowedAdminMasteredCityIds[]` — city-tier scope
- **Permission check is OR** — admin has access if `regionId ∈ allowedAdminMasteredRegionIds` OR `divisionId ∈ allowedAdminMasteredDivisionIds` OR `cityId ∈ allowedAdminMasteredCityIds` (`permissions.js:canManageEventsInLocation:215-237`)
- **Minimum viable scope:** at least ONE of the 3 arrays must have ≥1 ObjectId
- **Default for partition-scoped test setup:** single region in `allowedAdminMasteredRegionIds`; other 2 arrays empty
- **Triumvirate ALL-three-true gate** parallel to RO (`permissions.js:isActiveAdmin:199-206`)
- **No real-flow self-apply for RA** — admin elevation is admin-granted, not user-initiated. RA write paths: (a) CalOps admin UI, (b) test-mutator `elevate-test-user-role`, (c) manual mongosh override
- **Backend field name:** `localAdminInfo` (BE canonical per Fulton mongosh + code-trace `UserLogins.js:444,475`)
- **Write semantics:** all 3 flags written directly verbatim; no BE-side computation on PUT (Fulton code-trace confirmed)

### RO → RA (admin promotion of existing organizer)

```json
{
  "roleIds": ["<resolve ROLE_NU>", "<resolve ROLE_SL>", "<resolve ROLE_RO>", "<resolve ROLE_RA>"],
  "regionalOrganizerInfo": { "<preserved from RO state>": "..." },
  "localAdminInfo": { "<populated per NU→RA shape>": "..." }
}
```

- **`regionalOrganizerInfo` PRESERVED** from RO state on RA promotion (additive)
- **SL retained** if user has it (Spotlighter is RO-tier companion per TIEMPO-443)
- Same `localAdminInfo` shape and write semantics as NU→RA

### RA → NU (revert; defense-coverage, no current UC)

```json
{
  "roleIds": ["<resolve ROLE_NU>"],
  "localAdminInfo": {
    "isActive": false,
    "isApproved": false,
    "isEnabled": false,
    "allowedAdminMasteredRegionIds": [],
    "allowedAdminMasteredDivisionIds": [],
    "allowedAdminMasteredCityIds": []
  }
}
```

- Mirrors CalOps `disconnectUserFromOrganizer` flag-clearing pattern
- All flags `false`; arrays cleared

## Resolution logic

| Field | Resolution method | Source collection | Match field |
|---|---|---|---|
| `roleIds[*]` Pattern A (appId="99") | resolve-by-fixture-key (preferred) | `roles` | `_testFixtureKey: "ROLE_<CODE>"` |
| `roleIds[*]` Pattern B (appId="1") | resolve-by-name (fallback; production seeds lack fixture-key) | `roles` | `roleName` (full canonical: "NamedUser" / "Spotlighter" / "RegionalOrganizer" / "RegionalAdmin" / "SystemAdmin") + `appId: "1"` |
| `regionalOrganizerInfo.organizerId` | resolve-by-fixture-key Pattern A; explicit per-spawn for Pattern B | `organizers` | Pattern A: `_testFixtureKey: "E2EORG"`; Pattern B: caller provides |
| `localAdminInfo` regions/divisions/cities | resolve-by-fixture-key | `mastered*` collections | Per-test fixture (Sarah filed, manifest TBD if E2E expansion) |

**Resolve-by-name canonical recommendation:** matrix uses `roleName` full canonical for Pattern B fallback (cross-scheme safe). Phase B retro investigation: CalOps `useRoles.js:226-229` SYA/RGA/RGO is dead code per Fulton mongosh — Sarah PO-discretion TIEMPO cleanup ticket post-Sprint-2 close.

## Idempotency contract

- Query userLogins doc by `{ firebaseUserId, appId }` compound (per Sarah compound-scope lesson 2026-05-06; Pattern A appId="99", Pattern B appId="1")
- If `roleIds[]` already contains target role + sidecar info already at expected state → return `{ action: "noOp" }`
- Else upsert userLogins doc to target shape (SET semantics — replace whole `roleIds[]`) → return `{ action: "applied" }`

## Side-effects policy — Q9 OPTION B RATIFIED (Quinn 2026-05-06T19:32)

**`elevate-test-user-role` does NOT emit:**
- Audit-log entries
- Message-admin notifications
- Role-change-log entries

**CalOps client-side parity confirmed (per Dash grep):** zero hits for `audit | message-admin | messageAdmin | emit | side-effect` in CalOps `src/`. CalOps real-flow client behavior is identical to test-mutator skip behavior. BE-side audit emission unknown (Phase B retro material).

## Q ratifications table

| Q | Topic | Decision | Status |
|---|---|---|---|
| Q1 | Role names + codes | `roleName` full canonical preferred for resolve. Pattern A: `_testFixtureKey: "ROLE_<CODE>"`; Pattern B: `roleName + appId="1"`. CalOps SYA/RGA/RGO dead code per Fulton mongosh — retro cleanup | ✅ Sarah + Fulton + Dash + Quinn (Item #1 arbitration) |
| Q2 | NU→RO scoping rules | `userId` + `targetRole` + `organizerId` + `allowedMasteredRegionIds[]` + `appId` | ✅ Sarah + Dash |
| Q3 | NU→RO sidecar flags | All 3 (`isActive`, `isApproved`, `isEnabled`) flip `true` atomic; `allowedMasteredRegionIds[]` populated. Real-flow actor: CalOps `createOrganizer` admin action (atomic) OR individual toggle | ✅ Sarah + Dash |
| Q4 | RA scoping rules | 3 parallel arrays `allowedAdmin{Region,Division,City}MasteredIds[]`; OR-permission semantics; minimum 1 ObjectId in ≥1 array | ✅ Dash |
| Q5 | RA sidecar flags | Triumvirate parallel to RO; ALL 3 true gate. Actors: CalOps admin UI exclusively (no self-apply for RA). Direct-write all 3 flags atomically; no BE-side computation on PUT (Fulton code-trace `UserLogins.js`) | ✅ Sarah + Dash + Fulton mongosh |
| Q6 | NU+SL+RO bundle invariant (TIEMPO-443) | RO transition MUST honor; RA standalone (no SL bundle) | ✅ Sarah + Dash confirmed |
| Q7 | Idempotency contract | noOp on already-at-target; SET semantics for roleIds[]; compound-scope `{firebaseUserId, appId}` | ✅ Sarah + Fulton + Dash |
| Q8 | emailVerified Option-b stamp | Handled by `mark-test-user` (A2 design); orthogonal to role transition | ✅ E2EUSER spec v1.0 inheritance |
| Q9 | Side-effects skip | Option B; CalOps client-side parity confirmed (zero emit hits); BE-side audit emission unknown (Phase B retro item) | ✅ Quinn ratified 19:32 + Dash CalOps grep |
| Q10 | CALBEAF-155 / `/self-apply` convergence | Intentional divergence | ✅ Sarah + Fulton joint |
| Q11 | BE userlogins POST handler on missing role | Soft-fallback to `roleIds: []` (`UserLogins.js:363-369`); v1.1 manifest seed unblocks | ✅ Fulton-verified |
| Q12 | Pattern A vs B partition asymmetry | Pattern A appId="99" partition isolation; Pattern B appId="1" markers + ADR-0017 Layer-3 marker REJECT | ✅ Sprint 1 architectural finding |
| Q13 | Backend canonical admin sidecar field | `localAdminInfo` (BE on-disk per Fulton mongosh + `UserLogins.js:444,475`); `regionalAdminInfo` is CalOps UI alias (`useUsers.js:85,473-474`). Test-mutator writes `localAdminInfo` | ✅ Fulton mongosh-confirm 22:39 |
| Q14 | RA `isActive` write semantics | Direct-write verbatim (no BE-side computation on PUT per Fulton code-trace). All 3 flags `{isActive, isApproved, isEnabled}` written atomically | ✅ Fulton mongosh-confirm 22:39 |

## CALBEAF-155 cross-ref

- Atomic `/self-apply` (Fulton lane, queued behind M5 + E2E framework) is real-app endpoint with real side-effects
- `elevate-test-user-role` intentionally divergent: partition-scoped state setup, no side-effects
- Plan §6 BE-lane risk row: **"intentional-divergence-from-CALBEAF-155 by design"**

## Cross-app coordination (parking)

Cord (HJ appId=2) parallel matrix: identical structure, swap appId, separate role ObjectIds. Phase I prep; Quinn-as-relay when Cord cohort fires.

## Downstream coupling

- `elevate-test-user-role`: consumes this matrix
- `reset-test-user`: resets to E2EUSER baseline (`e2euser-spec.md`); Pattern A only
- `mark-test-user` (A2): orthogonal; markers + emailVerified
- `delete-test-user-by-correlation` (with cascade extension per Quinn 22:34 arbitration): Pattern B cleanup; cascades organizer with `_testFixtureKey: "E2EORG-${correlationId}"` at appId
- `reset-orphans`: Pattern A only (appId="99"); does NOT sweep Pattern B
- UCs: UC-0003 apply-as-organizer (Story 2.3 Sprint 2; uses real flow, NOT this endpoint); future UCs for RA elevation; future UCs for RO→RA promotion

## Change log

- v0.1 PRE-FOLD (2026-05-06T19:31 UTC) — Sarah TT-FE-side initial; RA placeholders
- v0.1 deltas (2026-05-06T19:45 UTC) — `roleNameCode` confirmed; manifest v1.1 prereq; resolution-by-fixture-key; Q11 BE-handler intel
- v1.0 PRE-FOLD (2026-05-06T22:35 UTC) — Toby ACK Option B+D hybrid; Sarah assembled v0.1 + 5 deltas + Q9 + Q12; RA rows placeholder; Quinn ratify 22:36; Fulton commit `c7bcfd2` (labeled-checkpoint)
- v1.0 FINAL (2026-05-06T22:42 UTC) — Path A confirmed (Dash hub-channel restored); Sarah single-round-fold of Dash CalOps RA inputs; Quinn Item #1 arbitration; Fulton 3 mongosh probes resolve favorably (Q13 + Q14 added); CalOps SYA/RGA/RGO discrepancy → Phase B retro
- v1.0 FINAL CLEAN (2026-05-06T22:43 UTC) — TODO-FULTON-2/3 status fields → ✅ RESOLVED inline; RA-row inline caveats removed; Q-table + architecture-frame absorb mongosh-probe resolutions; Quinn single-round ratify ☑
