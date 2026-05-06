// POST /api/test/elevate-test-user-role
// Body: { firebaseUserId: string, role: 'NU'|'RO'|'RA'|'SA', _testCorrelationId: string }
//
// Effect (in order):
//   1. LOAD-BEARING marker check: target userlogin must carry isE2ETestUser=true.
//      Reject 403 if marker missing.
//   2. Set userRole on the userlogin record.
//   3. For RO: set regionalOrganizerInfo (with linked placeholder organizer.organizerId).
//      Atomic both-direction wiring per CALBEAF/TIEMPO-453 sibling-bug class:
//      organizer.firebaseUserId AND userlogin.regionalOrganizerInfo.organizerId BOTH set.
//   4. For RA: set regionalAdminInfo.
//   5. For SA: set system-admin equivalent.
//   6. emailVerified bypass: admin.auth().updateUser(uid, { emailVerified: true })
//      to skip Gmail-OAuth fragility per Quinn ratify 2026-05-06T16:11.
//
// STUB STATUS: API surface registered; specific role-shape mutations TBD pending
// baseline manifest + canonical role-state spec coordination with Sarah.

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const { getFirebaseAdmin } = require('../lib/firebase');
const { requireE2ETestUserMarker, requireCorrelationIdMatch } = require('../middleware/markerCheck');

const VALID_ROLES = new Set(['NU', 'RO', 'RA', 'SA']);

async function elevateTestUserRoleHandler(request, context) {
    context.log('elevate-test-user-role: requested');

    try {
        const body = await request.json();
        const { firebaseUserId, role, _testCorrelationId } = body;

        if (!firebaseUserId || !role) {
            return badRequest('firebaseUserId and role required');
        }
        if (!VALID_ROLES.has(role)) {
            return badRequest(`role must be one of: ${Array.from(VALID_ROLES).join(', ')}`);
        }

        // ADR-0004 correlationId guard
        const corrIdGuard = requireCorrelationIdMatch(_testCorrelationId, undefined);
        if (corrIdGuard) return corrIdGuard;

        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Layer 3 LOAD-BEARING marker check
        const target = await userlogins.findOne({ firebaseUserId });
        const guard = requireE2ETestUserMarker(target, context);
        if (guard) return guard;

        // emailVerified bypass — runs once on first elevation (idempotent — Firebase noop if already true)
        const admin = getFirebaseAdmin();
        try {
            await admin.auth().updateUser(firebaseUserId, { emailVerified: true });
        } catch (err) {
            if (err.code !== 'auth/user-not-found') throw err;
        }

        // TODO (Phase B): per-role state mutations.
        // - NU: clear regionalOrganizerInfo + regionalAdminInfo; set roleIds=[NamedUser]
        // - RO: ensure-placeholder-organizer (idempotent); set both userlogin.regionalOrganizerInfo.organizerId
        //   AND organizer.firebaseUserId (atomic both-direction per TIEMPO-453 class). Drift-detect-and-repair
        //   on idempotent re-call.
        // - RA: set regionalAdminInfo (cityIds/divisionIds/regionIds per Sarah-coordinated baseline shape)
        // - SA: set systemAdmin equivalent
        //
        // For now: stub-set userRole field + isE2ETestUser preserved.
        await userlogins.updateOne(
            { firebaseUserId, isE2ETestUser: true },
            {
                $set: {
                    userRole: role,
                    _testCorrelationId,  // tag mutation with caller's correlationId
                    updatedAt: new Date()
                }
            }
        );

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                stub: true,
                message: `elevate-test-user-role stub: userRole=${role} set; per-role state mutations TBD per Phase B baseline manifest`,
                firebaseUserId,
                role,
                correlationId: _testCorrelationId,
                emailVerifiedSet: true,
                timestamp: new Date().toISOString()
            })
        };
    } catch (err) {
        context.error('elevate-test-user-role error:', err);
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

app.http('elevate-test-user-role', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/elevate-test-user-role',
    handler: elevateTestUserRoleHandler,
});
