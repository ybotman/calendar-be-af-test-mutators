// Firebase Admin singleton for the TEST-mutator Function App.
// Reads FIREBASE_JSON (base64-encoded service account JSON) from environment.

'use strict';

const admin = require('firebase-admin');

let firebaseApp = null;

function initializeFirebase() {
    if (firebaseApp) return firebaseApp;
    const firebaseJson = process.env.FIREBASE_JSON;
    if (!firebaseJson) throw new Error('FIREBASE_JSON not configured');
    const serviceAccount = JSON.parse(Buffer.from(firebaseJson, 'base64').toString('utf-8'));
    firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
    });
    return firebaseApp;
}

function getFirebaseAdmin() {
    if (!firebaseApp) initializeFirebase();
    return admin;
}

module.exports = { getFirebaseAdmin };
