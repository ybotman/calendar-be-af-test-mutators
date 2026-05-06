// POST /api/test/mark-test-user
//
// Post-signup test-readiness primitive (Option A2 ratified Quinn 2026-05-06T19:51;
// appId param added per Quinn 2026-05-06T20:18 architectural finding from Gauge UC-0002).
//
// Stamps Mongo markers + Firebase emailVerified in a single call.
//
// Body:
//   firebaseUserId: string (required)
//   correlationId:  string (required)
//   appId?:         string (default "99"); real-app signup-created users land at appId="1"
//                   per BE POST /api/userlogins/ default. Pattern B (UC-0002) sends "1";
//                   Pattern A (E2EUSER persistent) defaults to "99".
//   markers?:       { isE2ETestUser?: boolean (default true), isE2ETestPlaceholder?: boolean (default false) }
//   stampFirebaseEmailVerified?: boolean (default true) — Admin SDK Option-b stamp; idempotent
//
// Architectural note (Quinn 20:18 arbitration):
//   The appId="99" partition isolation per ADR-0004 applies to FIXTURE data
//   (events/organizers/roles via _testFixtureKey). User docs created by real-app
//   signup land at the appId the FE sends (default "1"). For real-flow-created users,
//   the **marker** (isE2ETestUser + _testCorrelationId), not the partition, is the
//   load-bearing test-membership signal. mark-test-user STAMPS that marker — defense
//   layers for this endpoint are: Layer 2 (function key) + the test framework's
//   knowledge of the freshly-minted firebaseUserId.

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const { getFirebaseAdmin } = require('../lib/firebase');

const DEFAULT_APP_ID = '99';
const ALLOWED_APP_IDS = new Set(['1', '2', '99']);  // TT, HJ, test-fixture partition

async function markTestUserHandler(request, context) {
    context.log('mark-test-user: requested');

    try {
        const body = await request.json();
        const {
            firebaseUserId,
            correlationId,
            appId = DEFAULT_APP_ID,
            markers = {},
            stampFirebaseEmailVerified = true,
        } = body;

        if (!firebaseUserId) return badRequest('firebaseUserId required');
        if (!correlationId) return badRequest('correlationId required');
        if (!ALLOWED_APP_IDS.has(appId)) {
            return badRequest(`appId must be one of: ${Array.from(ALLOWED_APP_IDS).join(', ')} (got "${appId}")`);
        }

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Locate target doc — scoped to caller-provided appId partition.
        // Pattern A (default appId="99"): persistent E2EUSER doc.
        // Pattern B (appId="1"): real-app-signup-created user (per Toby 16:07 lock).
        // One Firebase user can have docs in multiple appId partitions; the caller knows which.
        const target = await userlogins.findOne({ firebaseUserId, appId });
        if (!target) {
            return notFound(
                `userlogins doc not found for firebaseUserId=${firebaseUserId} on appId="${appId}". ` +
                `If this is post-signup, ensure BE userlogins POST handler completed before calling mark-test-user.`
            );
        }

        // Build $set payload
        const isE2ETestUser = markers.isE2ETestUser !== false; // default true
        const markerSet = {
            isE2ETestUser,
            _testCorrelationId: correlationId,
            updatedAt: new Date(),
        };
        if (markers.isE2ETestPlaceholder === true) {
            markerSet.isE2ETestPlaceholder = true;
        }

        const mongoResult = await userlogins.updateOne(
            { firebaseUserId, appId },
            { $set: markerSet }
        );

        // Optional Firebase emailVerified stamp (Option-b; idempotent)
        let firebaseStamped = false;
        let firebaseEmailVerified = null;
        let firebaseAction = 'skipped';
        if (stampFirebaseEmailVerified) {
            const adminSDK = getFirebaseAdmin();
            try {
                const fbUser = await adminSDK.auth().updateUser(firebaseUserId, { emailVerified: true });
                firebaseStamped = true;
                firebaseEmailVerified = fbUser.emailVerified;
                firebaseAction = 'stamped';
            } catch (err) {
                if (err.code === 'auth/user-not-found') {
                    firebaseAction = 'firebase_user_not_found';
                } else {
                    throw err;
                }
            }
        }

        const action = mongoResult.modifiedCount > 0 ? 'stamped' : 'noOp';

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                firebaseUserId,
                correlationId,
                appId,
                mongo: { modified: mongoResult.modifiedCount, matched: mongoResult.matchedCount },
                firebase: {
                    stamped: firebaseStamped,
                    emailVerified: firebaseEmailVerified,
                    action: firebaseAction,
                },
                action,
                timestamp: new Date().toISOString(),
            }),
        };
    } catch (err) {
        context.error('mark-test-user error:', err);
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

function notFound(message) {
    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_found', message }) };
}

function forbidden(code, message) {
    return { status: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: code, message }) };
}

app.http('mark-test-user', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/mark-test-user',
    handler: markTestUserHandler,
});
