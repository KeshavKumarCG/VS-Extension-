import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';

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
    const terminal = vscode.window.createTerminal({
        name: `Build Logger`,
        shellPath: "C:\\Windows\\System32\\cmd.exe", 
    });
    terminal.show();

    const buildCommand = vscode.workspace.getConfiguration('build-logger').get<string>('buildCommand') || 'npm run build';

    const buildProcess = spawn("cmd.exe", ["/c", buildCommand], { 
        cwd: workspacePath, 
        env: { ...process.env } 
    });

    let buildOutput = '';

    buildProcess.stdout.on('data', (data: Buffer) => {
        const message = data.toString();
        buildOutput += message;
        terminal.sendText(`echo ${message}`, true); 
    });

    buildProcess.stderr.on('data', (data: Buffer) => {
        const message = data.toString();
        buildOutput += message;
        terminal.sendText(`echo ${message}`, true); 
    });

    buildProcess.on('exit', async (code: number) => {
        if (code === 0) {
            vscode.window.showInformationMessage("Build Successful ✅");
        } else {
            const branchName = await getGitBranch();
            const developer = process.env.USER || process.env.USERNAME || "Unknown";

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

    buildProcess.on('error', (err) => {
        vscode.window.showErrorMessage(`Error running build command: ${err.message}`);
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
                if (!Array.isArray(logs)) {
                    logs = [];
                }
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

async function explainError(errorMessage: string): Promise<string> {
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'codellama', // Make sure you have a suitable model like `codellama` or `mistral`
            prompt: `Analyze this build error and provide a possible fix:\n\n"${errorMessage}"`,
            stream: false
        });

        return response.data.response.trim();
    } catch (err) {
        console.error("AI explanation error:", err);
        return "⚠️ AI could not generate a solution.";
    }
}

async function showBuildDashboard() {
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
            if (!Array.isArray(logs)) {
                logs = [];
            }
        } catch (error) {
            logs = [];
        }
    }

    const failedBuilds = logs.length;
    const errorList = await Promise.all(
        logs.map(async (log) => {
            const aiSuggestion = await explainError(log.error);
            return `
                <li>
                    <strong>📌 Error:</strong> ${log.error} <br>
                    <strong>🧠 AI Suggestion:</strong> ${aiSuggestion}
                </li>
            `;
        })
    );

    panel.webview.html = `
<html>
    <head>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background-color: #f4f4f4;
                color: #333;
                margin: 0;
                padding: 20px;
            }
            h2 {
                color: #007acc;
                border-bottom: 2px solid #007acc;
                padding-bottom: 10px;
            }
            .stats {
                margin-bottom: 20px;
                background-color: #fff;
                padding: 15px;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            ul {
                list-style-type: none;
                padding: 0;
            }
            li {
                margin-bottom: 8px;
                background-color: #fff;
                padding: 10px;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>🚨 Build Failure Dashboard</h2>
            <div class="stats">
                <p><strong>Total Failed Builds:</strong> ${failedBuilds}</p>
            </div>
            <h3>🔍 Most Recent Errors & Fixes</h3>
            <ul>${errorList.join('') || "<li>No errors logged yet.</li>"}</ul>
        </div>
    </body>
</html>
    `;
}


function exportLogs() {
    const exportPath = path.join(workspacePath, 'build_logs_export.json');
    fs.copyFileSync(logFilePath, exportPath);
    vscode.window.showInformationMessage(`Logs exported to: ${exportPath}`);
}

export function deactivate() { }