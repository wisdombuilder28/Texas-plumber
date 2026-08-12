// firebase-config.js
// Shared Firebase setup used by both the public site and the /admin dashboard.
//
// Get these values from: Firebase Console -> Project Settings -> General ->
// "Your apps" -> the web app's config snippet. Full walkthrough in FIREBASE_SETUP.md.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";



const firebaseConfig = {
  apiKey: "AIzaSyCZz-Nzke0GryitH-j8Lw6dplG6cbYxWdk",
  authDomain: "n-d-flow-plumbing.firebaseapp.com",
  projectId: "n-d-flow-plumbing",
  storageBucket: "n-d-flow-plumbing.firebasestorage.app",
  messagingSenderId: "641729795042"  ,
  appId: "1:641729795042:web:d8228b55be8bc22e645fbb",
  measurementId: "G-9LBTZMCXGV"
};


export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);  