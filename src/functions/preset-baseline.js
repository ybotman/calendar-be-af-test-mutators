// POST /api/test/preset-baseline
// Idempotent baseline staging per ADR-0004 §Preset.
// Reads baseline/manifest.json, processes organizers first (so events can resolve
// _ownerOrganizerShortName → ownerOrganizerID), then events (with name-resolutions
// + date-token expansion). All upserted by `_testFixtureKey` per Sarah's lock.
//
// Force-tag invariants (caller cannot override):
//   appId: 99
//   _testCorrelationId: "preset-baseline"

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const {
    loadManifest,
    transformEventFields,
    transformOrganizerFields,
    upsertByMatchKey,
} = require('../lib/baselineLoader');

async function presetBaselineHandler(request, context) {
    context.log('preset-baseline: idempotent baseline staging requested');

    try {
        const manifest = loadManifest();
        const db = await getDb();

        const summary = {
            schemaVersion: manifest.schemaVersion,
            roles: { inserted: 0, updated: 0, noOp: 0 },
            organizers: { inserted: 0, updated: 0, noOp: 0 },
            events: { inserted: 0, updated: 0, noOp: 0 },
            calendars: { inserted: 0, updated: 0, noOp: 0 },
            unresolvedReferences: [],
        };

        // ---- Roles first (foundational lookup table per Option X1, manifest v1.1) ----
        // appId="99" partition needs its own role docs; userlogins (future) resolve roleIds[*]
        // by _testFixtureKey "ROLE_<CODE>" lookup. Schema-parity with appId="1" docs.
        for (const r of (manifest.roles || [])) {
            const fields = {
                ...r.fields,
                appId: '99',
                _testCorrelationId: 'preset-baseline',
            };
            const result = await upsertByMatchKey(db, 'roles', r.matchKey, fields);
            summary.roles[result.action === 'inserted' ? 'inserted'
                : result.action === 'updated' ? 'updated'
                : 'noOp']++;
        }

        // ---- Organizers next ----
        // Process before events so events can resolve _ownerOrganizerShortName.
        for (const o of (manifest.organizers || [])) {
            const fields = transformOrganizerFields(o.fields);
            const result = await upsertByMatchKey(db, 'organizers', o.matchKey, fields);
            summary.organizers[result.action === 'inserted' ? 'inserted'
                : result.action === 'updated' ? 'updated'
                : 'noOp']++;
        }

        // ---- Events ----
        for (const e of (manifest.events || [])) {
            const fields = await transformEventFields(db, e.fields);

            // Track any unresolved references (name → ID) for visibility
            if (e.fields.categoryFirst && !fields.categoryFirstId) {
                summary.unresolvedReferences.push(`event "${e.fields.title || e.matchKey._testFixtureKey}": categoryFirst="${e.fields.categoryFirst}" not in categories collection`);
            }
            if (e.fields.masteredCityName && !fields.masteredCityId) {
                summary.unresolvedReferences.push(`event "${e.fields.title || e.matchKey._testFixtureKey}": masteredCityName="${e.fields.masteredCityName}" not in masteredcities collection`);
            }
            if (e.fields._ownerOrganizerShortName && !fields.ownerOrganizerID) {
                summary.unresolvedReferences.push(`event "${e.fields.title || e.matchKey._testFixtureKey}": _ownerOrganizerShortName="${e.fields._ownerOrganizerShortName}" not in organizers collection`);
            }

            const result = await upsertByMatchKey(db, 'events', e.matchKey, fields);
            summary.events[result.action === 'inserted' ? 'inserted'
                : result.action === 'updated' ? 'updated'
                : 'noOp']++;
        }

        // ---- Calendars (passthrough — no resolutions per current manifest) ----
        for (const c of (manifest.calendars || [])) {
            const result = await upsertByMatchKey(db, 'calendars', c.matchKey, {
                ...c.fields,
                appId: '99',
                _testCorrelationId: 'preset-baseline',
            });
            summary.calendars[result.action === 'inserted' ? 'inserted'
                : result.action === 'updated' ? 'updated'
                : 'noOp']++;
        }

        context.log(`preset-baseline complete: ${JSON.stringify(summary)}`);

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                summary,
                timestamp: new Date().toISOString()
            })
        };
    } catch (err) {
        context.error('preset-baseline error:', err);
        return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'internal_error', message: err.message })
        };
    }
}

app.http('preset-baseline', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/preset-baseline',
    handler: presetBaselineHandler,
});
