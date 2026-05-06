// Baseline manifest loader — reads baseline/manifest.json + applies the contract
// Sarah locked 2026-05-06: relative date tokens, resolve-by-name, _testFixtureKey upserts.
// v1.1 (2026-05-06): appId normalized to STRING "99" to match real-app schema (mongosh-confirmed
// unanimous string-typed appId across userlogins/organizers/events/venues/categories);
// roles[] seed collection added for partition-scoped role lookups.
//
// Force-tag invariants (caller cannot override; safety surface):
//   appId: "99"  (STRING — schema parity with real-app)
//   _testCorrelationId: "preset-baseline"

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', '..', 'baseline', 'manifest.json');
const TEST_USERS_PATH = path.join(__dirname, '..', '..', 'baseline', 'test-users.json');
const RESERVED_CORRELATION_ID = 'preset-baseline';
const TEST_APP_ID = '99';

let cachedTestUsers = null;

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

/**
 * Load baseline/test-users.json — Pattern A persistent test-user registry per E2EUSER spec v1.0.
 * Returns { schemaVersion, users: { <fixtureKey>: { _testFixtureKey, email, firebaseUid, displayName, appId } } }.
 * Empty registry returned if file absent (first-run; bootstrap-e2e-user.js populates).
 */
function loadTestUsers() {
    if (cachedTestUsers) return cachedTestUsers;
    if (!fs.existsSync(TEST_USERS_PATH)) {
        return { schemaVersion: '1.0', users: {} };
    }
    const raw = fs.readFileSync(TEST_USERS_PATH, 'utf8');
    cachedTestUsers = JSON.parse(raw);
    return cachedTestUsers;
}

/**
 * Build the post-reset baseline shape for an E2EUSER per spec v1.0.
 * Caller resolves NU role _id via resolveRoleIdByFixtureKey() before calling.
 */
function getE2EUserBaselineShape({ firebaseUid, email, displayName, roleId }) {
    return {
        _testFixtureKey: 'E2EUSER',
        appId: TEST_APP_ID,
        firebaseUserId: firebaseUid,
        roleIds: [roleId],
        regionalOrganizerInfo: {
            organizerId: null,
            isActive: false,
            isEnabled: false,
            isApproved: false,
        },
        regionalAdminInfo: {
            regionAdminId: null,
            isActive: false,
        },
        localUserInfo: {
            displayName,
            email,
        },
        active: true,
        isE2ETestUser: true,
        _testCorrelationId: RESERVED_CORRELATION_ID,
    };
}

/**
 * Resolve a role _id by _testFixtureKey lookup on appId="99" partition.
 * Used for roleIds[*] resolution in user-doc baseline shapes + matrix transitions.
 */
async function resolveRoleIdByFixtureKey(db, fixtureKey) {
    const doc = await db.collection('roles').findOne(
        { _testFixtureKey: fixtureKey, appId: TEST_APP_ID },
        { projection: { _id: 1 } }
    );
    return doc ? doc._id : null;
}

const ROLE_CODE_TO_NAME = {
    NU: 'NamedUser',
    SL: 'Spotlighter',
    RO: 'RegionalOrganizer',
    RA: 'RegionalAdmin',
    SA: 'SystemAdmin',
};

/**
 * Resolve a role _id with partition-aware lookup per matrix v1.0 resolution table.
 * - appId="99" (Pattern A): preferred via _testFixtureKey "ROLE_<CODE>" (manifest v1.1 seed)
 * - appId="1" / "2" (Pattern B / future HJ): roleName + appId lookup (production data)
 *
 * @param {Db} db
 * @param {string} code - "NU" | "SL" | "RO" | "RA" | "SA"
 * @param {string} appId - "99" | "1" | "2"
 * @returns {Promise<ObjectId|null>}
 */
async function resolveRoleId(db, code, appId) {
    if (appId === TEST_APP_ID) {
        return resolveRoleIdByFixtureKey(db, `ROLE_${code}`);
    }
    const roleName = ROLE_CODE_TO_NAME[code];
    if (!roleName) return null;
    const doc = await db.collection('roles').findOne(
        { roleName, appId },
        { projection: { _id: 1 } }
    );
    return doc ? doc._id : null;
}

/**
 * Resolve OR upsert the organizer doc to attach for an RO-tier elevation.
 * - Pattern A (appId="99"): resolve E2EORG fixture (must exist; preset-baseline seeds it).
 * - Pattern B (appId="1"/"2"): auto-upsert per-correlation test organizer at appId,
 *   marked with _testFixtureKey "E2EORG-<correlationId>" + _testCorrelationId + isE2ETestPlaceholder.
 *   Cascade-deleted by delete-test-user-by-correlation per Quinn arbitration 2026-05-06T22:34.
 * - Caller override: organizerIdOverride bypasses both paths; verifies existence at appId.
 */
async function resolveOrUpsertTestOrganizer(db, { appId, correlationId, organizerIdOverride }) {
    const { ObjectId } = require('mongodb');
    if (organizerIdOverride) {
        const oid = typeof organizerIdOverride === 'string' ? new ObjectId(organizerIdOverride) : organizerIdOverride;
        const doc = await db.collection('organizers').findOne({ _id: oid, appId });
        if (!doc) {
            const e = new Error(`organizerId override "${organizerIdOverride}" not found at appId="${appId}"`);
            e.code = 'organizer_override_not_found';
            throw e;
        }
        return { organizerId: doc._id, action: 'override', organizerFixtureKey: doc._testFixtureKey || null };
    }

    if (appId === TEST_APP_ID) {
        const e2eorg = await db.collection('organizers').findOne(
            { _testFixtureKey: 'E2EORG', appId: TEST_APP_ID },
            { projection: { _id: 1 } }
        );
        if (!e2eorg) {
            const e = new Error('E2EORG fixture not found at appId="99". Run preset-baseline first to seed manifest v1.1.');
            e.code = 'e2eorg_fixture_not_seeded';
            throw e;
        }
        return { organizerId: e2eorg._id, action: 'fixture_resolved', organizerFixtureKey: 'E2EORG' };
    }

    if (!correlationId) {
        const e = new Error(`Pattern B (appId="${appId}") requires correlationId for per-spawn test-organizer creation`);
        e.code = 'correlationId_required_for_pattern_b';
        throw e;
    }
    const fixtureKey = `E2EORG-${correlationId}`;
    const result = await db.collection('organizers').findOneAndUpdate(
        { _testFixtureKey: fixtureKey, appId },
        {
            $set: {
                _testFixtureKey: fixtureKey,
                _testCorrelationId: correlationId,
                isE2ETestPlaceholder: true,
                shortName: fixtureKey,
                name: `E2E Test Organizer (${correlationId})`,
                fullName: `E2E Test Organizer (${correlationId})`,
                description: `Synthetic test organizer for Pattern B per-spawn UC; cascade-deleted with delete-test-user-by-correlation. Do not display on real surfaces.`,
                isActive: true,
                isEnabled: true,
                isApproved: true,
                wantRender: true,
                organizerTypes: {
                    isEventOrganizer: true,
                    isVenue: false,
                    isTeacher: false,
                    isMaestro: false,
                    isDJ: false,
                    isOrchestra: false,
                    isTaxiDancer: false,
                    isVendor: false,
                },
                appId,
                updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, returnDocument: 'after' }
    );
    const upsertedDoc = result && (result.value || result);
    return {
        organizerId: upsertedDoc._id,
        action: result.lastErrorObject?.upserted ? 'created' : 'reused',
        organizerFixtureKey: fixtureKey,
    };
}

module.exports = {
    loadManifest,
    loadTestUsers,
    expandDateToken,
    resolveNameToId,
    resolveRoleIdByFixtureKey,
    resolveRoleId,
    resolveOrUpsertTestOrganizer,
    transformEventFields,
    transformOrganizerFields,
    getE2EUserBaselineShape,
    upsertByMatchKey,
    MANIFEST_PATH,
    TEST_USERS_PATH,
    RESERVED_CORRELATION_ID,
    TEST_APP_ID,
    ROLE_CODE_TO_NAME,
};
