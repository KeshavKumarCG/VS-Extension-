import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const logFilePath = path.join(__dirname, 'build_logs.json');

export function activate(context: vscode.ExtensionContext) {
    let trackBuildDisposable = vscode.commands.registerCommand('build-logger.trackBuilds', async () => {
        vscode.window.showInformationMessage('Build Logger Activated');

        const terminal = vscode.window.createTerminal(`Build Logger`);
        terminal.show();
        terminal.sendText("npm run build", true);

        terminal.processId?.then(pid => {
            vscode.window.onDidCloseTerminal(async (closedTerminal) => {
                const closedPid = await closedTerminal.processId;
                if (closedPid === pid) {
                    captureBuildErrors();
                }
            });
        });
    });

    let openDashboardDisposable = vscode.commands.registerCommand('build-logger.showDashboard', () => {
        showBuildDashboard();
    });

    context.subscriptions.push(trackBuildDisposable, openDashboardDisposable);
}

async function captureBuildErrors() {
    exec("npm run build 2>&1", async (error, stdout, stderr) => {
        if (!error && !stderr) {
            vscode.window.showInformationMessage("Build Successful ✅");
            return;
        }

        const errorMessage = stderr || stdout;
        const branchName = await getGitBranch();
        const developer = process.env.USER || process.env.USERNAME || "Unknown";

        const logEntry = {
            timestamp: new Date().toISOString(),
            error: errorMessage.trim(),
            branch: branchName,
            developer: developer
        };

        saveLog(logEntry);
        vscode.window.showErrorMessage(`Build failed: ${errorMessage.split("\n")[0]}`);
    });
}

function getGitBranch(): Promise<string> {
    return new Promise((resolve) => {
        exec("git rev-parse --abbrev-ref HEAD", (error, stdout) => {
            resolve(error ? "unknown" : stdout.trim());
        });
    });
}

function saveLog(logEntry: object) {
    try {
        let logs = [];
        if (fs.existsSync(logFilePath)) {
            const fileData = fs.readFileSync(logFilePath, 'utf8');
            logs = fileData ? JSON.parse(fileData) : [];
        }

        logs.push(logEntry);
        fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2));

    } catch (err) {
        vscode.window.showErrorMessage("Error saving build log: " + err);
    }
}

function showBuildDashboard() {
    const panel = vscode.window.createWebviewPanel(
        'buildLoggerDashboard',
        'Build Failure Dashboard',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    let logs = [];
    if (fs.existsSync(logFilePath)) {
        const fileData = fs.readFileSync(logFilePath, 'utf8');
        logs = fileData ? JSON.parse(fileData) : [];
    }

    const failedBuilds = logs.length;
    const errorCounts: { [key: string]: number } = {};

    logs.forEach((log: any) => {
        errorCounts[log.error] = (errorCounts[log.error] || 0) + 1;
    });

    const errorList = Object.entries(errorCounts)
        .map(([error, count]) => `<li><strong>${count}x</strong> ${error}</li>`)
        .join('');

    panel.webview.html = `
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                h2 { color: #007acc; }
                .stats { margin-bottom: 20px; }
                ul { list-style-type: none; padding: 0; }
                li { margin-bottom: 8px; }
            </style>
        </head>
        <body>
            <h2>Build Failure Dashboard</h2>
            <div class="stats">
                <p><strong>Total Failed Builds:</strong> ${failedBuilds}</p>
            </div>
            <h3>Most Common Errors</h3>
            <ul>${errorList}</ul>
        </body>
        </html>
    `;
}

export function deactivate() {}
