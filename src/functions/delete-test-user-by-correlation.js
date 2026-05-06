// POST /api/test/delete-test-user-by-correlation
//
// Pattern B cleanup primitive (UC-0002 afterAll). Cascades Firebase + Mongo deletion
// for the ephemeral per-spawn test user.
//
// Body:
//   correlationId:    string (required)
//   firebaseUserId?:  string (optional override; enables Sarah Option-(a) orphan-recovery fallback)
//
// Effect (in order):
//   1. Primary lookup: userlogins doc by { _testCorrelationId, appId: "99" } — happy path.
//   2. Fallback (Sarah Option a, orphan-recovery): if (1) misses AND firebaseUserId is provided,
//      lookup by { firebaseUserId, appId: "99" }. Handles the step-3→step-4 failure window
//      where mark-test-user didn't complete and the doc lacks _testCorrelationId.
//   3. Defense-in-depth REJECT on appId !== "99" (regardless of lookup path).
//   4. Defense-in-depth REJECT on missing isE2ETestUser=true marker — EXCEPT in the
//      firebaseUserId_fallback path (where the doc legitimately lacks markers because
//      mark-test-user failed). In fallback, defense composes from appId + uid match.
//   5. Delete Firebase user via admin.auth().deleteUser(uid). Idempotent on user-not-found.
//   6. Delete Mongo userlogins doc.
//   7. Per Q9 Option B (RATIFIED 2026-05-06T19:32): does NOT touch audit-log /
//      message-admin / userActions entries — real-flow side-effects intentionally untouched;
//      reset-orphans handles any leaked correlationId-tagged docs in subsequent runs.
//
// Composed defense-in-depth pattern with reset-orphans + mark-test-user:
//   - Happy path:                signup → mark → afterAll deletes by correlationId
//   - mark-test-user fails:      signup → ✗mark → afterAll deletes by firebaseUserId fallback
//   - Concurrent reset-orphans:  reset-orphans uses _testCorrelationId: { $exists: true } — won't sweep in-flight
//   - True orphan from prior:    reset-orphans sweeps with $exists: true + $nin: [active]
//
// Idempotent: missing correlationId returns 200 OK action: "noOp" (re-run safe in afterAll).

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const { getFirebaseAdmin } = require('../lib/firebase');

const TEST_APP_ID = '99';

async function deleteTestUserByCorrelationHandler(request, context) {
    context.log('delete-test-user-by-correlation: requested');

    try {
        const body = await request.json();
        const { correlationId, firebaseUserId } = body;

        if (!correlationId) return badRequest('correlationId required');

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Primary lookup: by correlationId + appId
        let target = await userlogins.findOne({
            _testCorrelationId: correlationId,
            appId: TEST_APP_ID,
        });
        let lookupPath = 'correlationId';

        // Fallback (Sarah Option a, orphan-recovery): if primary missed AND firebaseUserId provided
        if (!target && firebaseUserId) {
            target = await userlogins.findOne({
                firebaseUserId,
                appId: TEST_APP_ID,
            });
            if (target) lookupPath = 'firebaseUserId_fallback';
        }

        // No-Mongo-doc path: still attempt Firebase cleanup if uid known (full orphan recovery)
        if (!target) {
            let firebaseAction = 'skipped_no_uid';
            let firebaseDeleted = false;
            if (firebaseUserId) {
                const adminSDK = getFirebaseAdmin();
                try {
                    await adminSDK.auth().deleteUser(firebaseUserId);
                    firebaseDeleted = true;
                    firebaseAction = 'deleted_orphan';
                } catch (err) {
                    if (err.code === 'auth/user-not-found') {
                        firebaseAction = 'firebase_already_absent';
                    } else {
                        throw err;
                    }
                }
            }
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ok: true,
                    correlationId,
                    mongo: { deleted: 0, firebaseUserId: null },
                    firebase: { deleted: firebaseDeleted, action: firebaseAction },
                    action: firebaseDeleted ? 'deleted_via_firebase_uid_fallback_no_mongo' : 'noOp',
                    lookupPath: 'none',
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // Defense-in-depth REJECT: target.appId must be "99" (already filtered by query, but explicit safety)
        if (target.appId !== TEST_APP_ID) {
            return forbidden(
                'rejected_wrong_appid',
                `target appId="${target.appId}"; refusing delete (only appId="${TEST_APP_ID}" allowed)`
            );
        }

        // Defense-in-depth REJECT: marker check — but RELAXED on orphan-recovery path
        if (lookupPath === 'correlationId' && target.isE2ETestUser !== true) {
            return forbidden(
                'rejected_no_marker',
                'target lacks isE2ETestUser=true marker; refusing delete on correlationId-match path. ' +
                'For orphan recovery (mark-test-user failed mid-flow), pass firebaseUserId override to use the relaxed-marker fallback path.'
            );
        }
        // For firebaseUserId_fallback path: marker check intentionally relaxed because the doc
        // may legitimately lack the marker (mark-test-user didn't complete). Defense composes
        // from appId="99" + firebaseUserId match — both are strong discriminators.

        const targetUid = target.firebaseUserId;

        // Delete Mongo doc first (so reset-orphans on retry is idempotent)
        const mongoResult = await userlogins.deleteOne({ _id: target._id });

        // Delete Firebase user (idempotent on user-not-found)
        let firebaseDeleted = false;
        let firebaseAction = 'not_attempted';
        if (targetUid) {
            const adminSDK = getFirebaseAdmin();
            try {
                await adminSDK.auth().deleteUser(targetUid);
                firebaseDeleted = true;
                firebaseAction = 'deleted';
            } catch (err) {
                if (err.code === 'auth/user-not-found') {
                    firebaseAction = 'already_absent';
                } else {
                    throw err;
                }
            }
        }

        const action = lookupPath === 'firebaseUserId_fallback'
            ? 'deleted_via_firebase_uid_fallback'
            : 'deleted';

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                correlationId,
                mongo: { deleted: mongoResult.deletedCount, firebaseUserId: targetUid },
                firebase: { deleted: firebaseDeleted, action: firebaseAction },
                action,
                lookupPath,
                timestamp: new Date().toISOString(),
            }),
        };
    } catch (err) {
        context.error('delete-test-user-by-correlation error:', err);
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

function forbidden(code, message) {
    return { status: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: code, message }) };
}

app.http('delete-test-user-by-correlation', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/delete-test-user-by-correlation',
    handler: deleteTestUserByCorrelationHandler,
});
