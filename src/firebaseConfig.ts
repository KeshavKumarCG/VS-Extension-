import * as vscode from 'vscode';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
}

export function isFirebaseEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('build-logger');
  return config.get<boolean>('enableFirebaseLogging', false);
}

export function getFirebaseClientConfig(): FirebaseConfig {
  const config = vscode.workspace.getConfiguration('build-logger');
  
  // Check if Firebase logging is enabled
  if (!isFirebaseEnabled()) {
    throw new Error('Firebase logging is disabled. Enable it in VS Code settings.');
  }
  
  const firebaseConfig: FirebaseConfig = {
    apiKey: config.get<string>('firebaseConfig.apiKey') || '',
    authDomain: config.get<string>('firebaseConfig.authDomain') || '',
    projectId: config.get<string>('firebaseConfig.projectId') || '',
    storageBucket: config.get<string>('firebaseConfig.storageBucket') || '',
    messagingSenderId: config.get<string>('firebaseConfig.messagingSenderId') || '',
    appId: config.get<string>('firebaseConfig.appId') || '',
    measurementId: config.get<string>('firebaseConfig.measurementId') || '',
  };

  // Validate required fields
  const requiredFields = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
  const missingFields = requiredFields.filter(field => !firebaseConfig[field as keyof FirebaseConfig]);
  
  if (missingFields.length > 0) {
    const message = `Missing Firebase configuration fields: ${missingFields.join(', ')}`;
    vscode.window.showErrorMessage(
      `${message}. Please configure Firebase settings in VS Code preferences.`,
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'build-logger.firebaseConfig');
      }
    });
    throw new Error(message);
  }

  return firebaseConfig;
}