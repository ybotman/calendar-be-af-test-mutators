// POST /api/test/delete-test-user-by-correlation
//
// Pattern B cleanup primitive (UC-0002 + UC-0003 afterAll). Cascades Firebase + Mongo
// deletion for the ephemeral per-spawn test user, with organizer cascade for UC-0003.
//
// Body:
//   correlationId:    string (required)
//   firebaseUserId?:  string (optional override; enables Sarah Option-(a) orphan-recovery fallback)
//   appId?:           string (default "99"); real-app signup-created users land at appId="1" per
//                     BE POST /api/userlogins/ default. Pattern B (UC-0002/UC-0003) sends "1";
//                     Pattern A defaults to "99". Per Quinn 2026-05-06T20:18 architectural finding.
//
// Organizer cascade per Quinn arbitration 2026-05-06T22:34 (UC-0003 Story 2.3 cleanup contract):
//   Pattern B per-spawn organizers live at appId="1" with `_testFixtureKey: "E2EORG-${correlationId}"`
//   (created by elevate-test-user-role NU→RO transition). reset-orphans intentionally does NOT
//   sweep appId="1" (catastrophic risk against production data partition). Therefore organizer
//   cleanup MUST happen here. Cascade-delete is symmetric with user-delete — markers signal
//   test-membership across multiple docs (userLogins + organizer); cleanup primitive deletes both.
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

const DEFAULT_APP_ID = '99';
const ALLOWED_APP_IDS = new Set(['1', '2', '99']);

async function deleteTestUserByCorrelationHandler(request, context) {
    context.log('delete-test-user-by-correlation: requested');

    try {
        const body = await request.json();
        const { correlationId, firebaseUserId, appId = DEFAULT_APP_ID } = body;

        if (!correlationId) return badRequest('correlationId required');
        if (!ALLOWED_APP_IDS.has(appId)) {
            return badRequest(`appId must be one of: ${Array.from(ALLOWED_APP_IDS).join(', ')} (got "${appId}")`);
        }

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Primary lookup: by correlationId + caller-provided appId
        let target = await userlogins.findOne({
            _testCorrelationId: correlationId,
            appId,
        });
        let lookupPath = 'correlationId';

        // Fallback (Sarah Option a, orphan-recovery): if primary missed AND firebaseUserId provided
        if (!target && firebaseUserId) {
            target = await userlogins.findOne({
                firebaseUserId,
                appId,
            });
            if (target) lookupPath = 'firebaseUserId_fallback';
        }

        // No-Mongo-doc path: still attempt cascade cleanup of organizer + Firebase user if known
        // (full orphan recovery; symmetric with happy-path cascade)
        if (!target) {
            // Cascade-delete organizer by fixtureKey at appId (idempotent on missing)
            const organizerFixtureKey = `E2EORG-${correlationId}`;
            const organizerResult = await db.collection('organizers').deleteMany({
                _testFixtureKey: organizerFixtureKey,
                appId,
            });
            const organizerDeleted = organizerResult.deletedCount;

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

            const anythingDeleted = firebaseDeleted || organizerDeleted > 0;
            const action = anythingDeleted
                ? (firebaseDeleted && organizerDeleted > 0
                    ? 'deleted_via_firebase_uid_fallback_no_mongo_with_organizer_cascade'
                    : firebaseDeleted
                        ? 'deleted_via_firebase_uid_fallback_no_mongo'
                        : 'deleted_orphan_organizer_no_user')
                : 'noOp';

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ok: true,
                    correlationId,
                    appId,
                    mongo: { deleted: 0, firebaseUserId: null },
                    organizer: { deleted: organizerDeleted, fixtureKey: organizerFixtureKey },
                    firebase: { deleted: firebaseDeleted, action: firebaseAction },
                    action,
                    lookupPath: 'none',
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // Defense-in-depth REJECT: target.appId must match request.appId (already filtered by query, but explicit safety)
        if (target.appId !== appId) {
            return forbidden(
                'rejected_wrong_appid',
                `target appId="${target.appId}" mismatches request appId="${appId}"; refusing delete`
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

        // Delete Mongo userlogins doc first
        const mongoResult = await userlogins.deleteOne({ _id: target._id });

        // Cascade-delete organizer with _testFixtureKey: "E2EORG-${correlationId}" at same appId
        // (per Quinn arbitration 2026-05-06T22:34; UC-0003 cleanup contract).
        // reset-orphans does NOT sweep appId="1" partition (catastrophic risk against production
        // data); cascade-delete here is the cleanup path for Pattern B per-spawn organizers.
        const organizerFixtureKey = `E2EORG-${correlationId}`;
        const organizerResult = await db.collection('organizers').deleteMany({
            _testFixtureKey: organizerFixtureKey,
            appId,
        });
        const organizerDeleted = organizerResult.deletedCount;

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

        const action = (() => {
            if (lookupPath === 'firebaseUserId_fallback') {
                return organizerDeleted > 0
                    ? 'deleted_via_firebase_uid_fallback_with_organizer_cascade'
                    : 'deleted_via_firebase_uid_fallback';
            }
            return organizerDeleted > 0 ? 'deleted_with_organizer_cascade' : 'deleted';
        })();

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                correlationId,
                appId,
                mongo: { deleted: mongoResult.deletedCount, firebaseUserId: targetUid },
                organizer: { deleted: organizerDeleted, fixtureKey: organizerFixtureKey },
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
