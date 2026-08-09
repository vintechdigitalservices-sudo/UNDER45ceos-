// js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC8DNuOCSrVdhazlQxcQRBXlYZvHHZzqpc",
  authDomain: "under45ceos-submit.firebaseapp.com",
  projectId: "under45ceos-submit",
  storageBucket: "under45ceos-submit.firebasestorage.app",
  messagingSenderId: "801982436580",
  appId: "1:801982436580:web:3769913cb6ec23fbaa88f1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Firebase services
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;