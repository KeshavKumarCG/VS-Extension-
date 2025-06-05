import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc } from 'firebase/firestore';
import { firebaseConfig } from './firebaseConfig'; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export async function uploadToFirebase(log: any) {
    try {
        const docRef = await addDoc(collection(db, 'build_failures'), log);
        console.log("🔥 Firebase log saved with ID:", docRef.id);
    } catch (e) {
        console.error("❌ Error adding document to Firestore:", e);
    }
}
