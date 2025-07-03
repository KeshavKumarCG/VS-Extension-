import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getFirebaseClientConfig, isFirebaseEnabled } from './firebaseConfig';
import * as vscode from 'vscode';

let app: any = null;
let db: any = null;

function initializeFirebase() {
  if (!app) {
    try {
      const config = getFirebaseClientConfig();
      app = initializeApp(config);
      db = getFirestore(app);
    } catch (error) {
      console.error("❌ Failed to initialize Firebase:", error);
      throw error;
    }
  }
  return { app, db };
}

export async function uploadToFirebase(log: any): Promise<string | null> {
  // Check if Firebase logging is enabled
  if (!isFirebaseEnabled()) {
    console.log("🔄 Firebase logging is disabled, skipping upload");
    return null;
  }

  try {
    const { db } = initializeFirebase();
    
    // Add server timestamp and ensure data is clean
    const logEntry = {
      ...log,
      serverTimestamp: serverTimestamp(),
      timestamp: log.timestamp || new Date().toISOString(),
      error: String(log.error || ''),
      branch: String(log.branch || 'unknown'),
      developer: String(log.developer || 'Unknown Developer'),
      exitCode: Number(log.exitCode || 0),
      command: String(log.command || ''),
      workingDirectory: String(log.workingDirectory || ''),
      buildTime: log.buildTime || new Date().toISOString(),
      duration: Number(log.duration || 0),
      repoUrl: String(log.repoUrl || 'unknown'),
    };

    const docRef = await addDoc(collection(db, 'build_failures'), logEntry);
    console.log("🔥 Firebase log saved with ID:", docRef.id);
    
    // Show success notification
    vscode.window.showInformationMessage(
      `Build failure logged to Firebase (ID: ${docRef.id.substring(0, 8)}...)`
    );
    
    return docRef.id;
  } catch (error) {
    console.error("❌ Error adding document to Firestore:", error);
    
    // Show error notification with option to open settings
    vscode.window.showErrorMessage(
      'Failed to upload build log to Firebase. Check your configuration.',
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'build-logger.firebaseConfig');
      }
    });
    
    throw error;
  }
}