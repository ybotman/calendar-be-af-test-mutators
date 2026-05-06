// Baseline manifest loader — reads baseline/manifest.json + applies the contract
// Sarah locked 2026-05-06: relative date tokens, resolve-by-name, _testFixtureKey upserts.
//
// Force-tag invariants (caller cannot override; safety surface):
//   appId: 99
//   _testCorrelationId: "preset-baseline"

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', '..', 'baseline', 'manifest.json');
const RESERVED_CORRELATION_ID = 'preset-baseline';
const TEST_APP_ID = 99;

let cachedManifest = null;

function loadManifest() {
    if (cachedManifest) return cachedManifest;
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.appId !== TEST_APP_ID) {
        throw new Error(`manifest.appId mismatch: expected ${TEST_APP_ID}, got ${manifest.appId}`);
    }
    if (manifest._testCorrelationId !== RESERVED_CORRELATION_ID) {
        throw new Error(`manifest._testCorrelationId must be "${RESERVED_CORRELATION_ID}"`);
    }
    cachedManifest = manifest;
    return manifest;
}

/**
 * Expand relative date tokens like "+5d" / "+45d" to ISO date strings (UTC).
 * Token format: ^([+-]?\d+)d$  (days only — keep simple per Sarah spec v1).
 *
 * @param {string} token - e.g. "+5d", "-3d", "+0d"
 * @param {Date} baseDate - reference time (defaults to now)
 * @returns {Date}
 */
function expandDateToken(token, baseDate = new Date()) {
    if (typeof token !== 'string') return null;
    const m = token.match(/^([+-]?\d+)d$/);
    if (!m) throw new Error(`Invalid date token: "${token}". Expected format: +Nd or -Nd.`);
    const days = parseInt(m[1], 10);
    const expanded = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
    return expanded;
}

/**
 * Resolve a name → ObjectId via lookup in the named collection.
 * @param {Db} db
 * @param {string} collectionName
 * @param {string} fieldName - field to match by name
 * @param {string} value - the name value to look up
 * @returns {Promise<ObjectId|null>} matching doc's _id, or null
 */
async function resolveNameToId(db, collectionName, fieldName, value) {
    if (!value) return null;
    const doc = await db.collection(collectionName).findOne(
        { [fieldName]: value },
        { projection: { _id: 1 } }
    );
    return doc ? doc._id : null;
}

/**
 * Apply manifest's _resolveByName + _dateTokens transformations to a fields object.
 *
 * For events:
 *   - categoryFirst (name) → adds categoryFirstId (ObjectId from categories.name match)
 *   - masteredCityName (name) → adds masteredCityId (ObjectId from masteredcities.cityName match)
 *   - _ownerOrganizerShortName (name) → adds ownerOrganizerID (ObjectId from organizers.shortName match)
 *   - startDateOffset (token) → adds startDate (Date), removes startDateOffset
 *   - endDateOffset (token) → adds endDate (Date), removes endDateOffset
 *
 * Force-tags appId=99 + _testCorrelationId="preset-baseline" (overriding any caller value).
 *
 * Returns a NEW object; does not mutate input.
 */
async function transformEventFields(db, fields) {
    const out = { ...fields };

    // Resolve category by name
    if (out.categoryFirst && !out.categoryFirstId) {
        const id = await resolveNameToId(db, 'categories', 'categoryName', out.categoryFirst);
        if (id) out.categoryFirstId = id;
        else if (id === null) {
            // Try alternate field name (categories sometimes use "name" or "categoryName")
            const id2 = await resolveNameToId(db, 'categories', 'name', out.categoryFirst);
            if (id2) out.categoryFirstId = id2;
        }
    }

    // Resolve mastered city by cityName
    if (out.masteredCityName && !out.masteredCityId) {
        const id = await resolveNameToId(db, 'masteredcities', 'cityName', out.masteredCityName);
        if (id) out.masteredCityId = id;
    }

    // Resolve owner organizer by shortName
    if (out._ownerOrganizerShortName && !out.ownerOrganizerID) {
        const id = await resolveNameToId(db, 'organizers', 'shortName', out._ownerOrganizerShortName);
        if (id) out.ownerOrganizerID = id;
    }

    // Expand date tokens
    if (out.startDateOffset !== undefined) {
        out.startDate = expandDateToken(out.startDateOffset);
        delete out.startDateOffset;
    }
    if (out.endDateOffset !== undefined) {
        out.endDate = expandDateToken(out.endDateOffset);
        delete out.endDateOffset;
    }

    // Strip the helper field (we used it for resolution; not stored)
    delete out._ownerOrganizerShortName;

    // Force-tag invariants — overrides any caller-supplied value
    out.appId = TEST_APP_ID;
    out._testCorrelationId = RESERVED_CORRELATION_ID;

    return out;
}

/**
 * Apply force-tag invariants only (no resolutions/expansions) to a fields object.
 * Used for organizers (no name-resolutions needed).
 */
function transformOrganizerFields(fields) {
    return {
        ...fields,
        appId: TEST_APP_ID,
        _testCorrelationId: RESERVED_CORRELATION_ID,
    };
}

/**
 * Upsert a single record by matchKey in the given collection.
 * Returns { matched, modified, upsertedId, action: 'inserted'|'updated'|'no-op' }.
 */
async function upsertByMatchKey(db, collectionName, matchKey, fields) {
    const result = await db.collection(collectionName).updateOne(
        matchKey,
        {
            $set: { ...fields, updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    let action;
    if (result.upsertedCount > 0) action = 'inserted';
    else if (result.modifiedCount > 0) action = 'updated';
    else action = 'no-op';
    return {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        upsertedId: result.upsertedId || null,
        action,
    };
}

module.exports = {
    loadManifest,
    expandDateToken,
    resolveNameToId,
    transformEventFields,
    transformOrganizerFields,
    upsertByMatchKey,
    MANIFEST_PATH,
    RESERVED_CORRELATION_ID,
    TEST_APP_ID,
};
