#!/usr/bin/env node
// scripts/bootstrap-e2e-user.js
//
// Idempotent UID mint for the Pattern A E2EUSER persistent cohort per E2EUSER spec v1.0.
// One-time-per-environment bootstrap; safe to re-run (no-op if UID already captured).
//
// Effect:
//   1. Initialize Firebase Admin SDK from local service-account key.
//   2. Check Firebase Auth for tango.tiempo.test@gmail.com:
//      - If exists: capture UID from existing user.
//      - If absent: createUser({ email, password, emailVerified: true }) → capture new UID.
//   3. Read baseline/test-users.json → set users.E2EUSER.firebaseUid + status="ACTIVE".
//   4. Write back. Idempotent — re-running with already-populated firebaseUid no-ops.
//
// Usage:
//   FIREBASE_SA_KEY=~/.config/firebase/tangotiempo-257ff-admin-sdk.json \
//   TEST_USER_PWD=<rotated-test-pwd> \
//   node scripts/bootstrap-e2e-user.js
//
// Or accept defaults: FIREBASE_SA_KEY defaults to ~/.config/firebase/tangotiempo-257ff-admin-sdk.json;
// TEST_USER_PWD defaults to a randomly-generated 32-byte hex (rotated, never persisted).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const admin = require('firebase-admin');

const SA_KEY_PATH = process.env.FIREBASE_SA_KEY
    || path.join(os.homedir(), '.config', 'firebase', 'tangotiempo-257ff-admin-sdk.json');
const TEST_USERS_PATH = path.join(__dirname, '..', 'baseline', 'test-users.json');
const E2EUSER_EMAIL = 'tango.tiempo.test@gmail.com';
const E2EUSER_DISPLAY_NAME = 'E2E Test User';

function fail(msg) {
    console.error(`ERROR: ${msg}`);
    process.exit(1);
}

async function main() {
    if (!fs.existsSync(SA_KEY_PATH)) {
        fail(`Service-account key not found: ${SA_KEY_PATH}. Set FIREBASE_SA_KEY env var or place the key at the default path.`);
    }
    if (!fs.existsSync(TEST_USERS_PATH)) {
        fail(`baseline/test-users.json not found at ${TEST_USERS_PATH}. Expected schema v1.0 file.`);
    }

    const serviceAccount = JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf8'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
    });
    console.log(`[bootstrap] Firebase Admin initialized for project: ${serviceAccount.project_id}`);

    const auth = admin.auth();
    let user;
    let action;
    try {
        user = await auth.getUserByEmail(E2EUSER_EMAIL);
        action = 'existing';
        console.log(`[bootstrap] Existing Firebase user found: uid=${user.uid} emailVerified=${user.emailVerified}`);
    } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
        const password = process.env.TEST_USER_PWD || crypto.randomBytes(32).toString('hex');
        user = await auth.createUser({
            email: E2EUSER_EMAIL,
            password,
            displayName: E2EUSER_DISPLAY_NAME,
            emailVerified: true,
        });
        action = 'minted';
        console.log(`[bootstrap] New Firebase user minted: uid=${user.uid}`);
        if (!process.env.TEST_USER_PWD) {
            console.log('[bootstrap] (password was randomly generated; never persisted; rotate via Admin SDK if needed)');
        }
    }

    // Update baseline/test-users.json
    const testUsers = JSON.parse(fs.readFileSync(TEST_USERS_PATH, 'utf8'));
    const existingEntry = testUsers.users.E2EUSER || {};
    const wasPopulated = existingEntry.firebaseUid && existingEntry.firebaseUid !== null;

    if (wasPopulated && existingEntry.firebaseUid === user.uid) {
        console.log(`[bootstrap] test-users.json already in sync (firebaseUid=${user.uid}); no write needed`);
        return;
    }

    testUsers.users.E2EUSER = {
        _testFixtureKey: 'E2EUSER',
        email: E2EUSER_EMAIL,
        firebaseUid: user.uid,
        displayName: E2EUSER_DISPLAY_NAME,
        appId: '99',
        _testCorrelationId: 'preset-baseline',
        _status: 'ACTIVE',
        _bootstrappedAt: new Date().toISOString(),
        _bootstrapAction: action,
    };

    fs.writeFileSync(TEST_USERS_PATH, JSON.stringify(testUsers, null, 2) + '\n');
    console.log(`[bootstrap] Wrote ${TEST_USERS_PATH} (action=${action}; firebaseUid=${user.uid})`);
    console.log('[bootstrap] Next: commit baseline/test-users.json to test-mutators DEVL + redeploy Function App so reset-test-user can resolve UID at runtime.');
}

main().catch(err => {
    console.error('[bootstrap] FATAL:', err);
    process.exit(1);
});
