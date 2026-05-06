// POST /api/test/elevate-test-user-role
//
// Role-elevation primitive per role-elevation-matrix v1.0 (Sarah-authored, Quinn-ratified).
// Mirrors the post-state of the real-app apply/elevation flow without invoking either.
//
// Body:
//   firebaseUserId: string (required)
//   correlationId:  string (required) — _testCorrelationId for the user; per ADR-0004
//   targetRole:     "NU" | "SL" | "RO" | "RA" | "SA" (required)
//   appId?:         string (default "99"; allowed ["1","2","99"])
//                   — Pattern A (appId="99"): persistent E2EUSER cohort; roles via _testFixtureKey
//                   — Pattern B (appId="1"/"2"): real-app-signup user; roles via roleName + appId
//   organizerId?:   string (optional override; only meaningful for RO transitions)
//                   — If omitted on Pattern A: resolves E2EORG fixture
//                   — If omitted on Pattern B: auto-upserts per-correlation test organizer
//                     with _testFixtureKey "E2EORG-<correlationId>" (cascade-deleted by
//                     delete-test-user-by-correlation per Quinn arbitration 2026-05-06T22:34)
//
// Effect (NU→RO transition; PRIMARY for Story 2.3 / UC-0003):
//   1. Layer-3 marker check: target userlogins must carry isE2ETestUser=true.
//   2. Resolve role IDs (NU + SL + RO) per partition (TIEMPO-443 NU+SL+RO bundle invariant).
//   3. Resolve OR upsert organizer doc per partition strategy.
//   4. Idempotent updateOne on userlogins:
//      - roleIds: [<NU>, <SL>, <RO>] (SET semantics — replace, not delta)
//      - regionalOrganizerInfo: { organizerId, isActive: true, isApproved: true, isEnabled: true }
//   5. Per Q9 Option-B (RATIFIED 2026-05-06T19:32): does NOT emit audit-log,
//      message-admin, or role-change-log entries — partition-scoped state setup, not
//      behavioral test of those flows.
//
// RA / SA / NU / SL transitions: stubbed 501 NOT_IMPLEMENTED until matrix v1.0 final
// (RA rows pending Dash CalOps fill) + caller demand (no current UC).

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const {
    resolveRoleId,
    resolveOrUpsertTestOrganizer,
    TEST_APP_ID,
} = require('../lib/baselineLoader');
const { requireE2ETestUserMarker } = require('../middleware/markerCheck');

const DEFAULT_APP_ID = '99';
const ALLOWED_APP_IDS = new Set(['1', '2', '99']);
const VALID_TARGET_ROLES = new Set(['NU', 'SL', 'RO', 'RA', 'SA']);

async function elevateTestUserRoleHandler(request, context) {
    context.log('elevate-test-user-role: requested');

    try {
        const body = await request.json();
        const {
            firebaseUserId,
            correlationId,
            targetRole,
            appId = DEFAULT_APP_ID,
            organizerId: organizerIdOverride,
        } = body;

        if (!firebaseUserId) return badRequest('firebaseUserId required');
        if (!correlationId) return badRequest('correlationId required');
        if (!targetRole) return badRequest('targetRole required');
        if (!VALID_TARGET_ROLES.has(targetRole)) {
            return badRequest(`targetRole must be one of: ${Array.from(VALID_TARGET_ROLES).join(', ')} (got "${targetRole}")`);
        }
        if (!ALLOWED_APP_IDS.has(appId)) {
            return badRequest(`appId must be one of: ${Array.from(ALLOWED_APP_IDS).join(', ')} (got "${appId}")`);
        }

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Layer-3 marker check on the appId-scoped userlogins doc (per compound-scope memory)
        const target = await userlogins.findOne({ firebaseUserId, appId });
        const guard = requireE2ETestUserMarker(target, context);
        if (guard) return guard;

        // Dispatch on transition. Only NU→RO implemented for Story 2.3 / UC-0003.
        // Other transitions stubbed 501 until matrix v1.0 final + UC demand.
        if (targetRole === 'RO') {
            return await applyNUtoROTransition({
                db,
                userlogins,
                target,
                firebaseUserId,
                correlationId,
                appId,
                organizerIdOverride,
                context,
            });
        }

        return notImplemented(
            `targetRole="${targetRole}" not implemented yet. ` +
            `Only NU→RO transition is impl per role-elevation-matrix v1.0 (Story 2.3 scope). ` +
            `RA/SA stubs pending matrix v1.0 final (Dash CalOps fill in flight). ` +
            `NU/SL transitions are forward-compat stubs (no current UC demand).`
        );
    } catch (err) {
        if (err.code === 'organizer_override_not_found' || err.code === 'e2eorg_fixture_not_seeded' || err.code === 'correlationId_required_for_pattern_b') {
            return badRequest(err.message);
        }
        context.error('elevate-test-user-role error:', err);
        return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'internal_error', message: err.message }),
        };
    }
}

/**
 * NU → RO transition per role-elevation-matrix v1.0 PRIMARY row.
 * - roleIds: [<NU>, <SL>, <RO>] (SET semantics; TIEMPO-443 bundle invariant)
 * - regionalOrganizerInfo: { organizerId, isActive: true, isApproved: true, isEnabled: true }
 * - Direct-write: test-mutator writes all three sidecar flags (BE has no derived computation).
 */
async function applyNUtoROTransition({ db, userlogins, target, firebaseUserId, correlationId, appId, organizerIdOverride, context }) {
    // Resolve role IDs per partition strategy
    const [nuId, slId, roId] = await Promise.all([
        resolveRoleId(db, 'NU', appId),
        resolveRoleId(db, 'SL', appId),
        resolveRoleId(db, 'RO', appId),
    ]);

    const missing = [];
    if (!nuId) missing.push('NU');
    if (!slId) missing.push('SL');
    if (!roId) missing.push('RO');
    if (missing.length > 0) {
        return badRequest(
            `Role(s) not found at appId="${appId}": ${missing.join(', ')}. ` +
            (appId === TEST_APP_ID
                ? 'Run preset-baseline first to seed manifest v1.1 roles[].'
                : `Production roles collection at appId="${appId}" appears incomplete; needs roleName lookup match.`)
        );
    }

    // Resolve or upsert organizer doc per partition strategy
    const orgResult = await resolveOrUpsertTestOrganizer(db, {
        appId,
        correlationId,
        organizerIdOverride,
    });

    // Build target shape (full $set; idempotent)
    const updateSet = {
        roleIds: [nuId, slId, roId],
        regionalOrganizerInfo: {
            organizerId: orgResult.organizerId,
            isActive: true,
            isApproved: true,
            isEnabled: true,
        },
        _testCorrelationId: correlationId,  // stamp/refresh for cleanup correlation
        updatedAt: new Date(),
    };

    const result = await userlogins.updateOne(
        { _id: target._id },
        { $set: updateSet }
    );

    const action = result.modifiedCount > 0 ? 'applied' : 'noOp';

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ok: true,
            firebaseUserId,
            correlationId,
            appId,
            targetRole: 'RO',
            transition: 'NU_to_RO',
            roleIds: { NU: nuId, SL: slId, RO: roId },
            organizer: orgResult,
            action,
            modified: result.modifiedCount,
            timestamp: new Date().toISOString(),
        }),
    };
}

function badRequest(message) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'bad_request', message }) };
}

function notImplemented(message) {
    return { status: 501, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_implemented', message }) };
}

app.http('elevate-test-user-role', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/elevate-test-user-role',
    handler: elevateTestUserRoleHandler,
});
