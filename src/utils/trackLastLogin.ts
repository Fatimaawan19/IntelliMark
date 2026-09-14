import { db } from '../firebase';
import { doc, updateDoc, Timestamp } from 'firebase/firestore';

/**
 * Updates the lastLogin timestamp for a user 
 * @param userId - The Firestore document ID of the user
 */
export async function updateLastLogin(userId: string): Promise<void> {
  const userRef = doc(db, 'users', userId);
  await updateDoc(userRef, {
    lastLogin: Timestamp.now()
  });
}
