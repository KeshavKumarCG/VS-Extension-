import * as vscode from 'vscode';

export function getFirebaseConfig() {
  const config = vscode.workspace.getConfiguration('build-logger.firebaseConfig');
  return {
    apiKey: config.get<string>('apiKey') || '',
    authDomain: config.get<string>('authDomain') || '',
    projectId: config.get<string>('projectId') || '',
    storageBucket: config.get<string>('storageBucket') || '',
    messagingSenderId: config.get<string>('messagingSenderId') || '',
    appId: config.get<string>('appId') || '',
    measurementId: config.get<string>('measurementId') || ''
  };
}
