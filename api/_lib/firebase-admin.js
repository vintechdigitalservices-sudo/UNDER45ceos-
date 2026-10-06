/* ═══════════════════════════════════════════════════════════════
   api/_lib/firebase-admin.js
   Shared Firebase Admin bootstrap for the Vercel serverless
   functions. Reuses the service account already configured as
   FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL on Vercel (see
   README). Cached so warm invocations do not re-initialise.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

let cachedApp = null;

function getAdminApp() {
  if (cachedApp) return cachedApp;
  if (getApps().length) {
    cachedApp = getApps()[0];
    return cachedApp;
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    'under45ceos-submit';

  // Private key arrives from the env var with escaped \n sequences.
  const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';
  const privateKey = rawKey.replace(/\\n/g, '\n');

  if (!privateKey) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY is not set. Add it in Vercel → Settings → ' +
        'Environment Variables before deploying the API routes.'
    );
  }

  cachedApp = initializeApp({
    credential: cert({
      projectId,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel often stores the whole service-account JSON in one var.
      privateKey: privateKey.indexOf('{') === 0
        ? (JSON.parse(rawKey).private_key || '').replace(/\\n/g, '\n')
        : privateKey
    }),
    projectId
  });

  return cachedApp;
}

function db() {
  return getFirestore(getAdminApp());
}

function adminAuth() {
  return getAuth(getAdminApp());
}

/**
 * Resolves the caller from a Firebase ID token issued by the client SDK.
 * Returns { uid, email, isAdmin } or null when the token is absent or
 * invalid. `isAdmin` is driven by the ADMIN_EMAILS env var — the
 * inventory write endpoints refuse to act for anyone else, so a
 * logged-in volunteer can never deduct stock.
 */
async function requireAdmin(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(token);
  } catch (err) {
    return null;
  }

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    uid: decoded.uid,
    email: (decoded.email || '').toLowerCase(),
    isAdmin: adminEmails.includes((decoded.email || '').toLowerCase())
  };
}

module.exports = { getAdminApp, db, adminAuth, requireAdmin, Timestamp };
