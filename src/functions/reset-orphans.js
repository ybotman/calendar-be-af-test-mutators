// POST /api/test/reset-orphans
// correlationId-scoped orphan cleanup per ADR-0004 §Pre-spawn reset.
//
// Body: { activeCorrelationIds: [<currently-running spawns>], excludeCorrelationIds: ["preset-baseline"] }
// Effect: DELETE WHERE
//   { appId: "99",
//     _testCorrelationId: { $exists: true, $nin: activeCorrelationIds + ["preset-baseline"] } }
//
// Cascade collections mirror the preset-baseline write surface (organizers, events, calendars,
// roles) plus userlogins (anticipated by reset-test-user / UC-0002).
//
// **Race-window safety (Quinn ratify 2026-05-06T19:51):** the `$exists: true` clause
// preserves docs that exist on appId="99" but lack a `_testCorrelationId` field. Without
// it, MongoDB's `$nin` matches missing-field docs (null/missing $nin [array] is true),
// which would sweep in-flight signup docs in the step-3→step-4 window of UC-0002 (the
// post-signup, pre-mark-test-user gap). Composed defense-in-depth with the orphan-recovery
// firebaseUserId fallback in delete-test-user-by-correlation: in-flight docs persist until
// either mark-test-user stamps them OR afterAll cleanup recovers them.
//
// Quinn coordinates the active-spawn-list (knows in-flight Gauge spawns).
// preset-baseline is preserved (reserved correlationId for shared baseline data).

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');

async function resetOrphansHandler(request, context) {
    context.log('reset-orphans: orphan cleanup requested');

    try {
        const body = await request.json();
        const activeCorrelationIds = Array.isArray(body.activeCorrelationIds) ? body.activeCorrelationIds : [];
        const excludeCorrelationIds = Array.isArray(body.excludeCorrelationIds) ? body.excludeCorrelationIds : ['preset-baseline'];

        // Always preserve preset-baseline even if caller forgot to pass it.
        const preserveSet = new Set([...activeCorrelationIds, ...excludeCorrelationIds, 'preset-baseline']);

        const orphanFilter = {
            appId: '99',
            _testCorrelationId: { $exists: true, $nin: Array.from(preserveSet) }
        };

        const db = await getDb();

        const collections = ['userlogins', 'organizers', 'events', 'calendars', 'roles'];
        const deleted = {};
        for (const cName of collections) {
            const result = await db.collection(cName).deleteMany(orphanFilter);
            deleted[cName] = result.deletedCount;
        }

        const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
        context.log(`reset-orphans: deleted ${totalDeleted} orphan docs across ${collections.length} collections`);

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                preservedCorrelationIds: Array.from(preserveSet),
                deleted,
                totalDeleted,
                timestamp: new Date().toISOString()
            })
        };
    } catch (err) {
        context.error('reset-orphans error:', err);
        return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'internal_error', message: err.message })
        };
    }
}

app.http('reset-orphans', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/reset-orphans',
    handler: resetOrphansHandler,
});
