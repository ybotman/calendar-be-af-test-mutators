// POST /api/test/mark-test-user
//
// Post-signup test-readiness primitive (Option A2 ratified Quinn 2026-05-06T19:51).
// Stamps Mongo markers + Firebase emailVerified in a single call.
//
// Body:
//   firebaseUserId: string (required)
//   correlationId:  string (required)
//   markers?:       { isE2ETestUser?: boolean (default true), isE2ETestPlaceholder?: boolean (default false) }
//   stampFirebaseEmailVerified?: boolean (default true) — Admin SDK Option-b stamp; idempotent
//
// Effect:
//   1. Locate userlogins doc by firebaseUserId.
//   2. Defense-in-depth REJECT if doc.appId !== "99" (refuses to stamp prod data).
//   3. updateOne $set { isE2ETestUser, [isE2ETestPlaceholder], _testCorrelationId, updatedAt }.
//   4. If stampFirebaseEmailVerified (default true): admin.auth().updateUser(uid, { emailVerified: true })
//      — idempotent on Firebase side; no-ops if already true.
//
// Use cases:
//   - Pattern B post-signup (UC-0002 step 4): closes the Layer-3 REJECT gap window
//     between userLogins doc creation (real signup completes) and marker stamping.
//   - Pattern A bootstrap script: stamps E2EUSER persistent doc with markers on first-mint.
//   - Reusable primitive: any test-user state needing post-creation marker stamp.

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const { getFirebaseAdmin } = require('../lib/firebase');

const TEST_APP_ID = '99';

async function markTestUserHandler(request, context) {
    context.log('mark-test-user: requested');

    try {
        const body = await request.json();
        const {
            firebaseUserId,
            correlationId,
            markers = {},
            stampFirebaseEmailVerified = true,
        } = body;

        if (!firebaseUserId) return badRequest('firebaseUserId required');
        if (!correlationId) return badRequest('correlationId required');

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Locate target doc
        const target = await userlogins.findOne({ firebaseUserId });
        if (!target) {
            return notFound(`userlogins doc not found for firebaseUserId=${firebaseUserId}`);
        }

        // Defense-in-depth: refuse to stamp non-test-partition data
        if (target.appId !== TEST_APP_ID) {
            return forbidden(
                'rejected_wrong_appid',
                `mark-test-user refuses to stamp doc with appId="${target.appId}"; only appId="${TEST_APP_ID}" allowed`
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
            { firebaseUserId, appId: TEST_APP_ID },
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
