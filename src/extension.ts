import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
const logFilePath = path.join(workspacePath, 'build_logs.json');

export function activate(context: vscode.ExtensionContext) {
    let trackBuildDisposable = vscode.commands.registerCommand('build-logger.trackBuilds', async () => {
        vscode.window.showInformationMessage('Build Logger Activated');
        runBuildProcess();
    });

    let openDashboardDisposable = vscode.commands.registerCommand('build-logger.showDashboard', () => {
        showBuildDashboard();
    });

    let exportLogsDisposable = vscode.commands.registerCommand('build-logger.exportLogs', () => {
        exportLogs();
    });

    context.subscriptions.push(trackBuildDisposable, openDashboardDisposable, exportLogsDisposable);
}

function runBuildProcess() {
    const terminal = vscode.window.createTerminal(`Build Logger`);
    terminal.show();
    const buildCommand = vscode.workspace.getConfiguration('build-logger').get<string>('buildCommand') || 'npm run build';

    const buildProcess = spawn(buildCommand, { shell: true, env: { ...process.env } });
    let buildOutput = '';

    buildProcess.stdout.on('data', (data: Buffer) => {
        const message = data.toString();
        buildOutput += message;
        terminal.sendText(message, true);
    });

    buildProcess.stderr.on('data', (data: Buffer) => {
        const message = data.toString();
        buildOutput += message;
        terminal.sendText(message, true);
    });

    buildProcess.on('exit', async (code: number) => {
        if (code === 0) {
            vscode.window.showInformationMessage("Build Successful ✅");
        } else {
            const branchName = await getGitBranch();
            const developer = (process.env.USER as string) || (process.env.USERNAME as string) || "Unknown";
            
            const logEntry = {
                timestamp: new Date().toISOString(),
                error: buildOutput.trim(),
                branch: branchName,
                developer: developer
            };
            saveLog(logEntry);
            vscode.window.showErrorMessage(`Build failed! Check dashboard for details.`);
        }
    });
}

function getGitBranch(): Promise<string> {
    return new Promise((resolve) => {
        const gitProcess = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { env: { ...process.env } });
        let output = '';
        gitProcess.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        gitProcess.on('close', () => {
            resolve(output.trim() || 'unknown');
        });
    });
}

function saveLog(logEntry: object) {
    try {
        let logs: any[] = [];
        if (fs.existsSync(logFilePath)) {
            try {
                const fileData = fs.readFileSync(logFilePath, 'utf8');
                logs = fileData ? JSON.parse(fileData) : [];
                if (!Array.isArray(logs)) logs = [];
            } catch (error) {
                logs = [];
            }
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

    let logs: any[] = [];
    if (fs.existsSync(logFilePath)) {
        try {
            const fileData = fs.readFileSync(logFilePath, 'utf8');
            logs = fileData ? JSON.parse(fileData) : [];
            if (!Array.isArray(logs)) logs = [];
        } catch (error) {
            logs = [];
        }
    }

    const failedBuilds = logs.length;
    const errorCounts: { [key: string]: number } = {};

    logs.forEach((log) => {
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
                button { padding: 10px; background-color: #007acc; color: white; border: none; cursor: pointer; }
            </style>
        </head>
        <body>
            <h2>Build Failure Dashboard</h2>
            <div class="stats">
                <p><strong>Total Failed Builds:</strong> ${failedBuilds}</p>
            </div>
            <h3>Most Common Errors</h3>
            <ul>${errorList || "<li>No errors logged yet.</li>"}</ul>
            <button id="exportLogs">Export Logs</button>
            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById("exportLogs").addEventListener("click", () => {
                    vscode.postMessage({ command: "exportLogs" });
                });
            </script>
        </body>
        </html>
    `;

    panel.webview.onDidReceiveMessage(
        (message) => {
            if (message.command === "exportLogs") {
                exportLogs();
            }
        },
        undefined,
        []
    );
}

function exportLogs() {
    const exportPath = path.join(workspacePath, 'build_logs_export.json');
    fs.copyFileSync(logFilePath, exportPath);
    vscode.window.showInformationMessage(`Logs exported to: ${exportPath}`);
}

export function deactivate() {}