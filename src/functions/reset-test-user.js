// POST /api/test/reset-test-user
//
// Pattern A persistent-cohort reset primitive (E2EUSER spec v1.0).
// Resets the persistent E2EUSER's userlogins doc to the NU baseline shape between UCs.
// Does NOT delete the Firebase user (Pattern A invariant: mint-once, reset-MongoDB-only).
//
// Body:
//   fixtureKey?: string (default "E2EUSER")
//
// Effect (in order):
//   1. Resolve user identity from baseline/test-users.json[fixtureKey] (Fulton-bootstrapped via
//      scripts/bootstrap-e2e-user.js). Reject if absent or firebaseUid unpopulated.
//   2. Resolve NU role _id via roles._testFixtureKey: "ROLE_NU" lookup (manifest v1.1 seed).
//   3. Layer-3 marker check on existing userlogins doc (if present).
//      Cold-start exception: if doc absent, upsert creates new doc with markers.
//   4. Upsert userlogins doc to baseline shape per E2EUSER spec v1.0:
//      - roleIds: [<NU._id>], regionalOrganizerInfo null/false, regionalAdminInfo null/false,
//        localUserInfo (E2E identity), active: true, isE2ETestUser: true,
//        _testCorrelationId: "preset-baseline".
//
// NOT Pattern B (UC-0002 ephemeral cleanup) — that is delete-test-user-by-correlation.
//
// Idempotent: repeated calls converge to baseline shape; modifiedCount=0 if already at target.

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const {
    loadTestUsers,
    getE2EUserBaselineShape,
    resolveRoleIdByFixtureKey,
    TEST_APP_ID,
} = require('../lib/baselineLoader');
const { requireE2ETestUserMarker } = require('../middleware/markerCheck');

async function resetTestUserHandler(request, context) {
    context.log('reset-test-user: Pattern A reset requested');

    try {
        const body = await request.json().catch(() => ({}));
        const fixtureKey = body.fixtureKey || 'E2EUSER';

        // 1. Resolve user identity from registry
        const testUsers = loadTestUsers();
        const userSpec = testUsers.users[fixtureKey];
        if (!userSpec) {
            return badRequest(
                `fixtureKey "${fixtureKey}" not in baseline/test-users.json. ` +
                `Run scripts/bootstrap-e2e-user.js to populate the registry.`
            );
        }
        if (!userSpec.firebaseUid) {
            return badRequest(
                `fixtureKey "${fixtureKey}" present but firebaseUid is null/unpopulated. ` +
                `Run scripts/bootstrap-e2e-user.js to mint and capture the UID, then redeploy.`
            );
        }

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // 2. Resolve NU role _id
        const nuRoleId = await resolveRoleIdByFixtureKey(db, 'ROLE_NU');
        if (!nuRoleId) {
            return internalError(
                'NU role not seeded on appId="99" partition. ' +
                'Run preset-baseline first to seed manifest v1.1 roles[] (looks up _testFixtureKey: "ROLE_NU").'
            );
        }

        // 3. Layer-3 marker check on the APPID="99" doc only (one Firebase user can have docs in
        // multiple appId partitions; we only care about the test-partition doc here).
        // Cold-start path: if no appId="99" doc exists, marker check is bypassed and upsert creates new.
        const target = await userlogins.findOne({
            firebaseUserId: userSpec.firebaseUid,
            appId: TEST_APP_ID,
        });
        if (target) {
            const guard = requireE2ETestUserMarker(target, context);
            if (guard) return guard;
        }

        // 4. Build baseline shape + upsert
        const baselineShape = getE2EUserBaselineShape({
            firebaseUid: userSpec.firebaseUid,
            email: userSpec.email,
            displayName: userSpec.displayName,
            roleId: nuRoleId,
        });

        const result = await userlogins.updateOne(
            { firebaseUserId: userSpec.firebaseUid, appId: TEST_APP_ID },
            {
                $set: { ...baselineShape, updatedAt: new Date() },
                $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
        );

        const action = result.upsertedCount > 0 ? 'created'
            : result.modifiedCount > 0 ? 'reset'
            : 'noOp';

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                fixtureKey,
                firebaseUid: userSpec.firebaseUid,
                roleIdResolved: nuRoleId,
                action,
                modified: result.modifiedCount,
                upsertedId: result.upsertedId || null,
                timestamp: new Date().toISOString(),
            }),
        };
    } catch (err) {
        context.error('reset-test-user error:', err);
        return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'internal_error', message: err.message }),
        };
    }
}

function badRequest(message) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'bad_request', message }) };
}

function internalError(message) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'internal_error', message }) };
}

app.http('reset-test-user', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/reset-test-user',
    handler: resetTestUserHandler,
});
