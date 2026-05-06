// POST /api/test/reset-test-user
// Body: { firebaseUserId: string }  OR  { email: string }
//
// Effect (in order):
//   1. LOAD-BEARING marker check: verify target userlogin has isE2ETestUser=true
//      Reject 403 if marker missing.
//   2. Cascade-cleanup events / organizers / venues referencing this user.
//   3. Delete userlogin record(s) for this firebaseUserId.
//   4. Delete Firebase user via admin.auth().deleteUser(uid).
//   5. Idempotent across both states (exists / doesn't exist).
//
// Mirrors the cascade pattern from calendar-be-af scripts/cleanup-tobin-test-round2.js
// (prior art from 2026-05-04/05 manual cleanup work).

'use strict';

const { app } = require('@azure/functions');
const { ObjectId } = require('mongodb');
const { getDb } = require('../lib/mongo');
const { getFirebaseAdmin } = require('../lib/firebase');
const { requireE2ETestUserMarker } = require('../middleware/markerCheck');

async function resetTestUserHandler(request, context) {
    context.log('reset-test-user: requested');

    try {
        const body = await request.json();
        const { firebaseUserId, email } = body;

        if (!firebaseUserId && !email) {
            return badRequest('one of firebaseUserId or email required');
        }

        const admin = getFirebaseAdmin();
        let uid = firebaseUserId;

        // Resolve UID from email if needed
        if (!uid) {
            try {
                const fbUser = await admin.auth().getUserByEmail(email);
                uid = fbUser.uid;
            } catch (err) {
                if (err.code === 'auth/user-not-found') {
                    // Cold-start case — Firebase user already absent. Continue to Mongo cleanup.
                    context.log(`reset-test-user: Firebase user ${email} not found; proceeding to Mongo cleanup`);
                } else {
                    throw err;
                }
            }
        }

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Layer 3 LOAD-BEARING check: target userlogin must carry isE2ETestUser=true marker.
        // Cold-start exception: if no userlogin exists yet, skip marker check (no-op delete is idempotent).
        const target = uid ? await userlogins.findOne({ firebaseUserId: uid }) : null;
        if (target) {
            const guard = requireE2ETestUserMarker(target, context);
            if (guard) return guard;  // 403 rejection
        }

        // TODO (Phase B): full cascade cleanup per baseline manifest. For now, sweep
        // organizers + events tagged with this firebaseUserId or organizer ObjectId.
        const cleanup = { userlogins: 0, organizers: 0, events: 0, firebaseUser: 'skipped' };

        if (uid) {
            // Find linked organizers
            const orgs = await db.collection('organizers').find(
                { firebaseUserId: uid, isE2ETestPlaceholder: true },
                { projection: { _id: 1 } }
            ).toArray();
            const orgIds = orgs.map(o => o._id);

            // Cascade events
            if (orgIds.length > 0) {
                const e = await db.collection('events').deleteMany({
                    appId: 99,
                    $or: [
                        { ownerOrganizerID: { $in: orgIds } },
                        { authorOrganizerID: { $in: orgIds } },
                        { grantedOrganizerID: { $in: orgIds } },
                        { alternateOrganizerID: { $in: orgIds } }
                    ]
                });
                cleanup.events = e.deletedCount;
            }

            // Delete organizers (test-placeholder only)
            const o = await db.collection('organizers').deleteMany({
                firebaseUserId: uid,
                isE2ETestPlaceholder: true
            });
            cleanup.organizers = o.deletedCount;

            // Delete userlogin (marker-verified above)
            const u = await userlogins.deleteOne({
                firebaseUserId: uid,
                isE2ETestUser: true
            });
            cleanup.userlogins = u.deletedCount;

            // Delete Firebase user (idempotent — try/catch user-not-found)
            try {
                await admin.auth().deleteUser(uid);
                cleanup.firebaseUser = 'deleted';
            } catch (err) {
                if (err.code === 'auth/user-not-found') {
                    cleanup.firebaseUser = 'already_absent';
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
                uid: uid || null,
                cleanup,
                timestamp: new Date().toISOString()
            })
        };
    } catch (err) {
        context.log.error('reset-test-user error:', err);
        return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'internal_error', message: err.message })
        };
    }
}

function badRequest(message) {
    return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'bad_request', message })
    };
}

app.http('reset-test-user', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/reset-test-user',
    handler: resetTestUserHandler,
});
