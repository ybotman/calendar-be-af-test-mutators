// POST /api/test/preset-baseline
// Idempotent baseline staging per ADR-0004 §Preset.
// All baseline documents tagged `_testCorrelationId: "preset-baseline"` (reserved).
// Test users carry isE2ETestUser=true; placeholder organizers carry isE2ETestPlaceholder=true.
//
// STUB STATUS: API surface registered; body content TBD pending baseline manifest spec
// (open follow-up #1 from ADR-0004; coordinates with Sarah/Cord/Dash for app-specific shape).

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');

const RESERVED_CORRELATION_ID = 'preset-baseline';

async function presetBaselineHandler(request, context) {
    context.log('preset-baseline: idempotent baseline staging requested');

    try {
        const db = await getDb();
        const userlogins = db.collection('userlogins');

        // Idempotency: count existing baseline docs first
        const existingBaseline = await userlogins.countDocuments({
            appId: 99,
            _testCorrelationId: RESERVED_CORRELATION_ID,
            isE2ETestUser: true
        });

        // TODO (Phase B): implement baseline corpus per manifest spec.
        // - Test users (per Fulton baseline manifest, coordinates with Sarah/Cord/Dash)
        // - Test events (RRULE + non-recurring, with various category bindings)
        // - Test calendars
        // - Placeholder organizer with isE2ETestPlaceholder=true
        // All upserted (idempotent), all tagged _testCorrelationId="preset-baseline" + isE2ETestUser=true

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                stub: true,
                message: 'preset-baseline endpoint registered; baseline corpus content TBD per manifest spec (ADR-0004 open follow-up #1)',
                existingBaseline,
                reservedCorrelationId: RESERVED_CORRELATION_ID,
                timestamp: new Date().toISOString()
            })
        };
    } catch (err) {
        context.log.error('preset-baseline error:', err);
        return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'internal_error', message: err.message })
        };
    }
}

app.http('preset-baseline', {
    methods: ['POST'],
    authLevel: 'function',  // Layer 2: function key required
    route: 'test/preset-baseline',
    handler: presetBaselineHandler,
});
