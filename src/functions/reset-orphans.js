// POST /api/test/reset-orphans
// correlationId-scoped orphan cleanup per ADR-0004 §Pre-spawn reset.
//
// Body: { activeCorrelationIds: [<currently-running spawns>], excludeCorrelationIds: ["preset-baseline"] }
// Effect: DELETE WHERE { appId: 99, _testCorrelationId: { $nin: activeCorrelationIds + ["preset-baseline"] } }
//
// Cascade collections mirror the preset-baseline write surface (organizers, events, calendars)
// plus userlogins (anticipated by reset-test-user / UC-0002). Belt+suspenders sweep — any
// appId=99 record without a preserved correlationId is by definition orphan junk.
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
            appId: 99,
            _testCorrelationId: { $nin: Array.from(preserveSet) }
        };

        const db = await getDb();

        const collections = ['userlogins', 'organizers', 'events', 'calendars'];
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
