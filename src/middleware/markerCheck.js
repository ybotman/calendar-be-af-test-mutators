// Layer 3 of 4-Layer Defense-in-Depth (per ADR-0017).
//
// LOAD-BEARING SAFETY SURFACE: any mutation touching userlogins documents MUST
// verify the target's `isE2ETestUser` field is exactly `true` before any write.
// PROD has zero records with this marker, so endpoints are functionally inert in
// PROD even if other gates leak.
//
// Usage in handlers:
//   const target = await collection.findOne({ firebaseUserId: uid });
//   const guard = requireE2ETestUserMarker(target, context);
//   if (guard) return guard;  // 403 response with reason
//   // ...proceed with mutation
//
// For correlationId-tagged documents (appId=99 + _testCorrelationId), use
// requireCorrelationIdMatch() in addition.

'use strict';

/**
 * Returns a 403 response if the target document is missing the isE2ETestUser=true
 * marker. Returns null if the guard passes (caller may proceed with mutation).
 *
 * @param {object|null} target - The userlogin document loaded from Mongo, or null
 *   if not found. A null target is rejected (cannot mutate a non-existent record
 *   — caller should explicitly handle "create new" path with a different guard).
 * @param {object} context - Azure Functions context (for logging).
 * @returns {object|null} - 403 response object, or null if guard passes.
 */
function requireE2ETestUserMarker(target, context) {
    if (!target) {
        context.log('markerCheck: target document not found; rejecting');
        return forbiddenResponse('target_not_found', 'Target userlogin not found');
    }
    if (target.isE2ETestUser !== true) {
        context.log(`markerCheck: target ${target._id} missing isE2ETestUser=true marker; rejecting`);
        return forbiddenResponse(
            'isE2ETestUser_marker_required',
            'Target document does not carry the isE2ETestUser=true marker. ' +
            'TEST-mutator endpoints REJECT mutations on any userlogin without this marker. ' +
            'Per ADR-0017 §Defense-in-Depth Layer 3.'
        );
    }
    return null;  // guard passes
}

/**
 * Returns a 403 response if the request body's _testCorrelationId is missing,
 * malformed, or doesn't match the target document. Returns null if the guard passes.
 *
 * Per ADR-0004: correlationId format is ${UC_ID}-${unix_ts}-${rand4hex}, ≤32 chars.
 * Reserved value "preset-baseline" is allowed for baseline operations.
 *
 * @param {string} provided - correlationId from request body.
 * @param {string|undefined} target - correlationId on the target document (if any).
 * @param {object} options - { allowReserved: boolean }
 * @returns {object|null}
 */
function requireCorrelationIdMatch(provided, target, options = {}) {
    if (!provided || typeof provided !== 'string') {
        return forbiddenResponse('correlationId_missing', '_testCorrelationId required in request');
    }
    if (provided.length > 32) {
        return forbiddenResponse('correlationId_invalid_length', '_testCorrelationId must be ≤32 chars');
    }
    if (target !== undefined && target !== provided) {
        if (options.allowReserved && target === 'preset-baseline') {
            return null;  // reading baseline data is OK
        }
        return forbiddenResponse(
            'correlationId_mismatch',
            'Request _testCorrelationId does not match target document'
        );
    }
    return null;
}

function forbiddenResponse(code, message) {
    return {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            error: code,
            message,
            timestamp: new Date().toISOString()
        })
    };
}

module.exports = {
    requireE2ETestUserMarker,
    requireCorrelationIdMatch,
};
