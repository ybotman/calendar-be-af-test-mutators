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
// CALBEAF-177-companion / UC-0020 path-(a): persist Pattern A E2EUSER credentials to a
// gitignored env file so Pattern A browser-login UCs can read the password. Quinn-Sarah-Fulton
// three-way convergence 2026-05-07T21:33Z; Quinn arbiter ratify; lane = Fulton (per ADR-0017
// + B.2 §15 BE-canonical authority). Path (b) Firebase custom-token injection = Sprint 6 candidate.
const ENV_TEST_LOCAL_PATH = path.join(__dirname, '..', '.env.test.local');
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
    let mintedPassword = null;  // captured if/when we mint or re-bind; persisted for Pattern A browser-login UCs
    try {
        user = await auth.getUserByEmail(E2EUSER_EMAIL);
        action = 'existing';
        console.log(`[bootstrap] Existing Firebase user found: uid=${user.uid} emailVerified=${user.emailVerified}`);

        // UC-0020 path-(a): on existing user with TEST_USER_PWD env present, re-bind
        // the Firebase password to the chosen value AND persist. Admin SDK can't recover
        // the existing password, so re-bind is the only way to put a known credential
        // into .env.test.local for browser-login UCs.
        if (process.env.TEST_USER_PWD) {
            await auth.updateUser(user.uid, { password: process.env.TEST_USER_PWD });
            mintedPassword = process.env.TEST_USER_PWD;
            action = 'rebound';
            console.log(`[bootstrap] Re-bound existing user password from TEST_USER_PWD env (uid=${user.uid})`);
        }
    } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
        // Firebase password complexity: requires upper case + non-alphanumeric.
        // Random hex alone is rejected (lowercase + digits only). Append "Aa#" suffix to satisfy.
        mintedPassword = process.env.TEST_USER_PWD
            || (crypto.randomBytes(32).toString('hex') + 'Aa#');
        user = await auth.createUser({
            email: E2EUSER_EMAIL,
            password: mintedPassword,
            displayName: E2EUSER_DISPLAY_NAME,
            emailVerified: true,
        });
        action = 'minted';
        console.log(`[bootstrap] New Firebase user minted: uid=${user.uid}`);
    }

    // UC-0020 path-(a) credential persistence (Sprint 5 unblock).
    // When we mint a fresh user OR caller provides TEST_USER_PWD, persist the
    // password to .env.test.local for Pattern A browser-login UCs. Path (b)
    // Firebase custom-token injection is queued for Sprint 6 ADR.
    //
    // Existing-user case (action='existing') with no env file: warn + instruct
    // caller; Admin SDK can't recover Firebase passwords, so re-mint or
    // password-reset is required to populate.
    if (mintedPassword) {
        const envContent =
            `# Pattern A E2EUSER credentials — TEST partition (appId=99) only\n` +
            `# Generated by scripts/bootstrap-e2e-user.js per UC-0020 path-(a) Quinn ratify 2026-05-07\n` +
            `# DO NOT commit (gitignored). DO NOT use outside Pattern A test contexts.\n` +
            `E2EUSER_EMAIL=${E2EUSER_EMAIL}\n` +
            `E2EUSER_PASSWORD=${mintedPassword}\n` +
            `E2EUSER_FIREBASE_UID=${user.uid}\n`;
        fs.writeFileSync(ENV_TEST_LOCAL_PATH, envContent, { mode: 0o600 });
        console.log(`[bootstrap] Wrote Pattern A credentials to ${ENV_TEST_LOCAL_PATH} (mode 0600; gitignored)`);
    } else if (action === 'existing' && !fs.existsSync(ENV_TEST_LOCAL_PATH)) {
        console.warn(`[bootstrap] WARNING: existing Firebase user but no ${ENV_TEST_LOCAL_PATH}.`);
        console.warn('[bootstrap]          Pattern A browser-login UCs will fail without persisted credentials.');
        console.warn('[bootstrap]          To resolve: re-run with TEST_USER_PWD set (re-binds password + persists),');
        console.warn('[bootstrap]          OR reset the user password via Firebase Admin SDK and re-run.');
    } else if (action === 'existing') {
        console.log(`[bootstrap] Existing user; ${ENV_TEST_LOCAL_PATH} present (assumed-valid; not overwritten)`);
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
