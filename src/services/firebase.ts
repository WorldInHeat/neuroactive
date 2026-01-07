import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBlNWkezjbXlOZ7SQCuN9FWO0ScV4zuTc8",
  authDomain: "neuroactive.firebaseapp.com",
  projectId: "neuroactive",
  storageBucket: "neuroactive.firebasestorage.app",
  messagingSenderId: "1010503840940",
  appId: "1:1010503840940:web:90874fb37a70c9c7115b09",
  measurementId: "G-4X86RF0RQT"
};

export const appId = 'neuroactive-prod';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
