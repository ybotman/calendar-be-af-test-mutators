# Role-Elevation Matrix v1.0 PRE-FOLD

**Status:** v1.0 PRE-FOLD 2026-05-06T22:35 UTC — Toby ACK Option B+D hybrid 22:30. NU→RO scope ratified for Story 2.3 Sprint 2 fire. RA rows PENDING DASH CALOPS FILL (placeholder per Sarah-side default-assumption; 30-min Toby copy/paste relay window from 22:30).
**Owners:** Sarah (TT FE contract) + Dash (CalOps contract for RA rows); Quinn arbiter; Fulton commits + impls.
**Consumer:** `elevate-test-user-role` (TEST-mutator endpoint, per ADR-0017)
**Companion fixture:** `baseline/manifest.json` schemaVersion 1.1 (events + organizer + 5-role seed; commit `b14afdc` 2026-05-06T19:43)
**Companion spec:** `baseline/e2euser-spec.md` (E2EUSER baseline shape v1.0; commit `391f2ad`)
**Companion registry:** `baseline/test-users.json` (UID registry; Fulton-populated on first reset-test-user fire per Pattern A bootstrap)

## Architecture frame

- Test-mutator endpoint is **partition-scoped state mutator** (per Pattern A: `appId="99"` + `_testFixtureKey`; per Pattern B: `appId="1"` + markers `isE2ETestUser` + `_testCorrelationId`), NOT a real-app behavioral test of apply/elevation flows.
- Real-app behavioral testing of apply (TT FE-driven `UserSettingsApply.js`) or admin elevation (CalOps-driven) belongs to dedicated UCs that drive those flows directly.
- `elevate-test-user-role` mirrors the **post-state** of either real flow without invoking either.
- Intentional divergence from atomic `/self-apply` (CALBEAF-155 / TIEMPO-441, BE-side, queued behind M5 + E2E framework). Different contracts: real-side-effects vs partition-scoped state setup.

**Manifest v1.1 prerequisite (commit `b14afdc`, 2026-05-06T19:43 UTC):** `roles[]` seed at `appId: "99"` (string) with all 5 codes (NU/SL/RO/RA/SA) and verbatim `permissions[]` from production `appId: "1"` docs. Idempotent migration normalized pre-existing events/organizers from `appId: 99` (number) → `appId: "99"` (string) via upsert. `_testFixtureKey: "ROLE_<CODE>"` pattern enables resolve-by-key for `roleIds[*]` in test-mutator transitions.

## TT FE write paths to userLogins (grounding)

| Path | Use | Source |
|---|---|---|
| `POST /api/userlogins/` | Initial userLogin doc creation post-Firebase-signup | `tangotiempo.com/src/app/contexts/AuthContext.js:489-530` |
| `PUT /api/userlogins/updateUserInfo` | Profile field updates | `useUserLogins.js:158` |
| `PUT /api/userlogins/{firebaseUserId}/roles` | Role array mutations (apply-as-organizer flow) | `useUserLogins.js:165` |

**Apply-as-organizer flow** (TT FE-driven, NOT CalOps-only): `src/app/components/Modals/UserSettings/UserSettingsApply.js`. User clicks Apply → FE bundles `[NU._id, SL._id, RO._id]` + creates organizer record + sets `regionalOrganizerInfo` flags + logs role change.

## Spotlighter context (TT FE knowledge)

- `roleName: "Spotlighter"`, `roleNameCode: "SL"` (per `useMessages.js:20`, `ComposeMessageModal.js:43,59`)
- TIEMPO-431: Spotlighter is "real" (renders as normal role)
- ROLE_DISPLAY_ORDER (TIEMPO-431, `SiteMenuBarUserDrawer.js:38`): `['NamedUser', 'Spotlighter', 'RegionalOrganizer', 'RegionalAdmin', 'SystemAdmin', 'SystemOwner']`
- Master code constant: `SPOTLIGHTER: 'Spotlighter'` in `src/app/utils/masterData.js:5`
- Capabilities: TIEMPO-433 SpotlightOnlyModal (stripped-down view); TIEMPO-436 mirrors RO menu but limited; TIEMPO-438 hides image controls
- **No scoping sidecar:** no organizerId, no venueId, no region/city. Pure role-tier in `roleIds[]`.
- **NU+SL+RO retention invariant** (TIEMPO-443, `UserSettingsApply.js:78,230-232`): apply flow bundles `[NU._id, SL._id, RO._id]` so user is never orphaned to RO-only.

## Transition rows

### NU → Spotlighter (standalone tier; defensive coverage, no current UC)

```json
{
  "roleIds": ["<resolve _testFixtureKey: ROLE_NU>", "<resolve _testFixtureKey: ROLE_SL>"],
  "regionalOrganizerInfo": { "organizerId": null, "isActive": false, "isApproved": false, "isEnabled": false },
  "regionalAdminInfo": { "regionAdminId": null, "isActive": false }
}
```

- **Sidecar info:** none flips
- **Notes:** No current UC exercises Spotlighter-only tier; row provided for forward-compatibility per ROLE_DISPLAY_ORDER

### NU → RO (regional organizer) — Story 2.3 / UC-0003 PRIMARY TRANSITION

```json
{
  "roleIds": [
    "<resolve _testFixtureKey: ROLE_NU>",
    "<resolve _testFixtureKey: ROLE_SL>",
    "<resolve _testFixtureKey: ROLE_RO>"
  ],
  "regionalOrganizerInfo": {
    "organizerId": "<resolve _testFixtureKey: E2EORG>",
    "isActive": true,
    "isApproved": true,
    "isEnabled": true
  }
}
```

- **NU+SL retention** per TIEMPO-443 invariant
- **`isEnabled` direct-write:** Test-mutator writes `true` directly. AuthContext.js:170-178 warning logic requires all three flags `true` for working RO state.
  - Real-flow actor: PENDING DASH CALOPS FILL (placeholder default-assumption: BE `/roles` endpoint auto-flips, OR CalOps admin manually toggles, OR atomic `/self-apply` when CALBEAF-155 lands; non-blocking on test-mutator impl since end-state is known)
- **Request body shape:** `{ userId, targetRole: "RegionalOrganizer", organizerId, appId }` — `organizerId` defaults to E2EORG by `_testFixtureKey` lookup if omitted; `appId` defaults per Pattern A (`"99"`) or Pattern B (`"1"`) per caller's partition context

### NU → RA (regional admin) — PENDING DASH CALOPS FILL

```
PLACEHOLDER — Dash to populate when engaged.

Sarah-side default-assumption (best-effort, may be incorrect):
- roleIds: [<resolve ROLE_NU>, <resolve ROLE_RA>]  (Note: SL bundling for RA is unknown; default-assumption is NOT bundled — RA is admin-tier, not content-tier)
- regionalAdminInfo: {
    regionAdminId: <unknown — Dash to define schema>,
    isActive: true,
    isEnabled: <unknown — same actor-Q as RO>,
    isApproved: <unknown>
    /* + any region/city/country scoping fields per CalOps semantics */
  }
- Scoping: regionId? cityIds[]? countryId? — Dash to define
- Spotlighter bundling for RA: default-assumption NO; Dash confirms or corrects

Quinn arbitration if Dash content arrives during 22:30-23:00 window: Sarah folds inline → full v1.0 (RA rows filled) + Quinn ratifies in single round.
```

### RO → RA (admin promotion of existing organizer) — PENDING DASH CALOPS FILL

```
PLACEHOLDER — Dash to populate when engaged.

Sarah-side default-assumption (best-effort, may be incorrect):
- roleIds: [<ROLE_NU>, <ROLE_SL>, <ROLE_RO>, <ROLE_RA>]  (preserves RO state on RA promotion; assumption based on FE display-order showing RA as superset)
- regionalOrganizerInfo: { /* preserved from RO state */ }
- regionalAdminInfo: { /* per NU→RA placeholder; PENDING DASH */ }
- Quinn arbitration on RO retention if Dash differs.
```

## Resolution logic

| Field | Resolution method | Source collection | Match field |
|---|---|---|---|
| `roleIds[*]` | resolve-by-fixture-key (preferred) OR resolve-by-name (fallback) | `roles` | `_testFixtureKey: "ROLE_<CODE>"` (`ROLE_NU` / `ROLE_SL` / `ROLE_RO` / `ROLE_RA` / `ROLE_SA`) — preferred. Fallback: `roleName` + `appId: "99"` (string) |
| `regionalOrganizerInfo.organizerId` | resolve-by-fixture-key | `organizers` | `_testFixtureKey` (default `"E2EORG"`) + appId per partition |
| `regionalAdminInfo.regionId` | TBD by Dash | (unknown) | TBD |

## Idempotency contract

Mirror of preset-baseline upsert pattern + Pattern A reset-test-user precedent:
- Query userLogins doc by `{ firebaseUserId, appId }` compound (partition-aware per Pattern A vs B asymmetry; per Sarah compound-scope lesson 2026-05-06)
- If `roleIds[]` already contains target role + sidecar info already at expected state → return `{ action: "noOp" }`
- Else upsert userLogins doc to target shape → return `{ action: "applied" }`
- Idempotent: repeated calls converge to same end-state without side effects

## Side-effects policy — Q9 OPTION B RATIFIED (Quinn 2026-05-06T19:32)

**`elevate-test-user-role` does NOT emit:**
- Audit-log entries (real apply/elevation flows do; test-mutator does not)
- Message-admin notifications (real flows do; test-mutator does not)
- Role-change-log entries (FE `logRoleChange()` at `UserSettingsApply.js:247` runs in real flow only)

**Rationale (joint Sarah + Fulton vote, ratified Quinn):**
1. Test-mutator endpoint is for state setup, not behavioral testing of audit/messaging path
2. UCs that test audit-log behavior drive the real flow directly, not the mutator
3. `appId="99"` partition (Pattern A) and marker-tagged docs (Pattern B) are isolated per ADR-0004 + ADR-0017 Layer-3
4. `reset-orphans` cleans leaked side-effects on appId="99"; afterAll cleanup handles Pattern B
5. Convergence with `/self-apply` (CALBEAF-155) NOT required — intentional divergence by design

## Q ratifications table

| Q | Topic | Decision | Status |
|---|---|---|---|
| Q1 | Role names + codes | `roleName` + `roleNameCode` BOTH PRESENT on appId="1" docs (Fulton mongosh 19:36, 11/12 docs — Spotlighter source-data nit fixed in TEST per Option 4 + CALBEAF-182); v1.1 manifest seed (commit `b14afdc`) populates appId="99" partition with all 5 codes (NU/SL/RO/RA/SA) | OK Sarah + Fulton joint (mongosh-grounded) |
| Q2 | NU→RO scoping rules | `userId` + `targetRole` + `organizerId` (default E2EORG by fixture-key) + `appId` (Pattern A "99" or Pattern B "1" per caller partition) | OK Sarah |
| Q3 | NU→RO sidecar flags | All three (`isActive`, `isApproved`, `isEnabled`) flip `true`; test-mutator writes directly | OK Sarah; Dash to clarify real-flow actor for `isEnabled` (non-blocking) |
| Q4 | RA scoping rules | PENDING DASH | Dash placeholder |
| Q5 | RA sidecar flags | PENDING DASH (parallel `isEnabled` actor question recurses) | Dash placeholder |
| Q6 | NU+SL+RO bundle invariant | Test-mutator MUST honor TIEMPO-443 | OK Sarah (FE-grounded) |
| Q7 | Idempotency contract | noOp on already-at-target; mirrors preset-baseline + reset-test-user pattern; compound-scope `{ firebaseUserId, appId }` per Sarah lesson | OK Sarah + Fulton joint |
| Q8 | emailVerified Option-b stamp | `true` steady state, no per-transition action; handled separately by `mark-test-user` (A2 design) | OK E2EUSER spec v1.0 Q4 inheritance |
| Q9 | Side-effects (audit-log + message-admin) | Option B (skip both) | OK Quinn ratified 2026-05-06T19:32 |
| Q10 | CALBEAF-155 / atomic `/self-apply` convergence | Intentional divergence by design (different contracts) | OK Sarah + Fulton joint |
| Q11 | BE userlogins POST handler on missing role | Soft-fallback to `roleIds: []` (`calendar-be-af/.../UserLogins.js:363-369`); does NOT throw on lookup miss. Empty roleIds + TIEMPO-430 FE filter → AnonymousUser fallback. v1.1 manifest seed unblocks via partition seed | OK Fulton-verified |
| Q12 | Pattern A vs B partition asymmetry | Pattern A = appId="99" partition isolation; Pattern B = appId="1" markers + ADR-0017 Layer-3 marker REJECT as full safety burden | OK Sprint 1 architectural finding (Sarah + Fulton + Gauge) |

## CALBEAF-155 cross-ref note

- Atomic `/self-apply` endpoint (BE-side, Fulton lane, queued behind M5 + E2E framework) will be a real-app endpoint with real side-effects when landed
- `elevate-test-user-role` is intentionally divergent: partition-scoped state setup, no side-effects (per Option B)
- When `/self-apply` lands, TT FE `UserSettingsApply.js` `handleApply` flow simplifies (drops manual stopgap block at lines 282-308); test-mutator contract unchanged
- Plan §6 BE-lane risk row (per Fulton plan update): **"intentional-divergence-from-CALBEAF-155 by design"**

## Cross-app coordination (parking)

Cord (HJ appId=2) will need parallel matrix for HJ-side cohort. Suggested shape: identical structure, swap `appId: 2`, separate role ObjectIds (HJ may have different role names per HJ taxonomy in MASTER-CALENDAR-SYNC). Hand-off via Quinn-as-relay when Cord's cohort fires (Phase I prep). Non-blocking now.

## Downstream coupling

- `elevate-test-user-role` endpoint: consumes this matrix
- `reset-test-user` endpoint: resets to E2EUSER baseline (per `e2euser-spec.md`); inverse of any elevation (NU baseline = no elevations active)
- `mark-test-user` endpoint (A2): orthogonal — handles markers + emailVerified, not role transitions
- `delete-test-user-by-correlation` endpoint: orthogonal — Pattern B cleanup
- `reset-orphans` endpoint: sweeps appId="99" docs lacking `_testFixtureKey` AND `_testCorrelationId` ($exists belt+suspenders per Quinn ratify 2026-05-06T19:51) — does NOT touch correctly-tagged elevation state
- UCs consuming this matrix: UC-0003 apply-as-organizer (Story 2.3 / Sprint 2 fire); future UCs for RA elevation (TBD when Dash engages); future UCs for RO→RA promotion (TBD)

## Change log

- v0.1 PRE-FOLD (2026-05-06T19:31 UTC) — Sarah authored TT-FE-side; Dash CalOps-side rows pending; Quinn arbitration on Q9 (Option B) pending
- v0.1 deltas (2026-05-06T19:45 UTC) — Sarah folded post-mongosh: `roleNameCode` confirmed; manifest v1.1 prereq; resolution logic via `_testFixtureKey: "ROLE_<CODE>"`; transition row `_testFixtureKey` syntax; Q11 BE-handler intel addendum
- v1.0 PRE-FOLD (2026-05-06T22:35 UTC) — Toby ACK Option B+D hybrid; assembled v0.1 + 5 deltas + Q9 Option-B ratified + Q1 mongosh-confirmed + Q12 Pattern A vs B asymmetry + manifest v1.1 prereq context. RA rows placeholder PENDING DASH CALOPS FILL (30-min Toby copy/paste relay window from 22:30 UTC). NU→RO scope ratified for Story 2.3 Sprint 2 fire per Plan §4.
- v1.0 (anticipated when Dash engages) — RA rows filled + Q4/Q5 ratified + Quinn single-round ratify
