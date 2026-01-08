import { doc, setDoc } from 'firebase/firestore';
import type { UserData } from '../state/types';
import { auth, db, appId } from './firebase';

export async function saveUserData(updates: Partial<UserData>) {
  const user = auth.currentUser;
  if (!user) return;

  const ref = doc(db, 'artifacts', appId, 'users', user.uid, 'userData', 'main');
  await setDoc(ref, updates, { merge: true });
},


