// POST /api/test/seed-with-correlation
// Body: { collection: string, document: object, _testCorrelationId: string }
//
// Effect: insert a document into the given collection, force-tagging it with
//   appId: 99 (overriding any caller-supplied appId; safety invariant)
//   _testCorrelationId: <body._testCorrelationId>
//
// OPTIONAL endpoint per ADR-0017. If Gauge can seed via test code by adding
// _testCorrelationId support to standard CRUD calls in the harness layer, this
// endpoint is unnecessary. Provided for cases where Gauge needs direct insert
// (e.g., baseline-data variations, edge-case fixtures).
//
// STUB STATUS: skeleton only. Whitelist of allowed collections + per-collection
// shape validation TBD pending Phase B coordination.

'use strict';

const { app } = require('@azure/functions');
const { getDb } = require('../lib/mongo');
const { requireCorrelationIdMatch } = require('../middleware/markerCheck');

// Hardcoded allowlist — only these collections accept seed-with-correlation writes.
// Tightening prevents test framework from creating arbitrary collections.
const ALLOWED_COLLECTIONS = new Set([
    'events',
    'organizers',
    'venues',
    'userlogins',
    'calendars',
]);

async function seedWithCorrelationHandler(request, context) {
    context.log('seed-with-correlation: requested');

    try {
        const body = await request.json();
        const { collection, document, _testCorrelationId } = body;

        if (!collection || !document || !_testCorrelationId) {
            return badRequest('collection, document, and _testCorrelationId required');
        }
        if (!ALLOWED_COLLECTIONS.has(collection)) {
            return badRequest(`collection must be one of: ${Array.from(ALLOWED_COLLECTIONS).join(', ')}`);
        }

        const corrIdGuard = requireCorrelationIdMatch(_testCorrelationId, undefined);
        if (corrIdGuard) return corrIdGuard;

        // Safety invariants: force appId=99 + _testCorrelationId on every seed.
        // Caller cannot override these; prevents accidental write to production tier.
        const docToInsert = {
            ...document,
            appId: 99,
            _testCorrelationId,
            createdAt: document.createdAt || new Date(),
        };

        const db = await getDb();
        const result = await db.collection(collection).insertOne(docToInsert);

        return {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                _id: result.insertedId,
                collection,
                _testCorrelationId,
                timestamp: new Date().toISOString()
            })
        };
    } catch (err) {
        context.error('seed-with-correlation error:', err);
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

app.http('seed-with-correlation', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'test/seed-with-correlation',
    handler: seedWithCorrelationHandler,
});
