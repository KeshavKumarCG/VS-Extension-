import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec } from 'child_process';

// Constants for configuration
const MAX_LOG_ENTRIES = 1000; // Prevent log files from growing indefinitely
const MAX_ERROR_LENGTH = 5000; // Truncate very long error messages

let workspacePath: string;
let logFilePath: string;
let buildTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {

    workspacePath = getCorrectWorkspacePath();

    if (!fs.existsSync(path.join(workspacePath, 'package.json'))) {
        vscode.window.showWarningMessage(
            'Build Logger: No package.json found in current workspace. Some features may not work properly.',
            'Open Project Folder'
        ).then(selection => {
            if (selection === 'Open Project Folder') {
                vscode.commands.executeCommand('vscode.openFolder');
            }
        });
    }

    // Get log file path from configuration or use default
    const configLogPath = vscode.workspace.getConfiguration('build-logger').get<string>('logFilePath');
    logFilePath = configLogPath
        ? path.resolve(workspacePath, configLogPath)
        : path.join(workspacePath, 'build_logs.json');

    // Ensure log directory exists
    ensureLogDirectoryExists();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('build-logger.trackBuilds', trackBuilds),
        vscode.commands.registerCommand('build-logger.showDashboard', showBuildDashboard),
        vscode.commands.registerCommand('build-logger.exportLogs', exportLogs)
    );
}

function getCorrectWorkspacePath(): string {

    if (vscode.workspace.workspaceFolders?.length) {
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    if (vscode.window.activeTextEditor?.document.uri.fsPath) {
        return path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
    }

    const cwd = process.cwd();
    const vscodeInstallPath = path.dirname(process.execPath);

    if (cwd.startsWith(vscodeInstallPath)) {
        return path.dirname(cwd);
    }

    return cwd;
}

function ensureLogDirectoryExists() {
    const logDir = path.dirname(logFilePath);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
}

async function trackBuilds() {
    try {
        vscode.window.showInformationMessage('Build Logger Activated');

        // Clean up any existing terminal
        if (buildTerminal) {
            buildTerminal.dispose();
        }

        await runBuildProcess();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to track builds: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function runBuildProcess() {

    if (!workspacePath || !fs.existsSync(workspacePath)) {
        vscode.window.showErrorMessage('Invalid workspace path. Please open a project folder first.');
        return;
    }

    const buildCommand = getValidatedBuildCommand();
    const isWindows = process.platform === 'win32';

    // Create terminal with appropriate shell for the platform
    buildTerminal = vscode.window.createTerminal({
        name: `Build Logger`,
        shellPath: isWindows ? "C:\\Windows\\System32\\cmd.exe" : undefined,
        cwd: workspacePath
    });
    buildTerminal.show();

    // Log that we're starting the build
    vscode.window.showInformationMessage(`Running build command in ${workspacePath}`);

    // Spawn the build process with appropriate command for the platform
    const buildProcess = isWindows
        ? spawn("cmd.exe", ["/c", buildCommand], {
            cwd: workspacePath,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        })
        : spawn("/bin/sh", ["-c", buildCommand], {
            cwd: workspacePath,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

    let buildOutput = '';
    let outputTimer: NodeJS.Timeout;

    const appendToTerminal = (data: string) => {
        // Clear any pending output
        if (outputTimer) {
            clearTimeout(outputTimer);
        }

        // Batch output to prevent flooding the terminal
        buildOutput += data;
        outputTimer = setTimeout(() => {
            if (buildTerminal) {
                // Use safer method to send text to terminal
                const sanitized = data.replace(/[^\x20-\x7E\r\n]/g, '');
                buildTerminal.sendText(`echo "${sanitized.replace(/"/g, '\\"')}"`, true);
            }
        }, 100);
    };

    buildProcess.stdout.on('data', (data: Buffer) => {
        appendToTerminal(data.toString());
    });

    buildProcess.stderr.on('data', (data: Buffer) => {
        appendToTerminal(data.toString());
    });

    buildProcess.on('exit', async (code: number | null) => {
        if (outputTimer) {
            clearTimeout(outputTimer);
        }

        try {
            if (code === 0) {
                vscode.window.showInformationMessage("Build Successful ✅");
            } else {
                // Get developer and branch info
                const [branchName, developer] = await Promise.all([
                    getGitBranch(),
                    getDeveloperName()
                ]);

                const logEntry = {
                    timestamp: new Date().toISOString(),
                    error: truncateString(buildOutput.trim(), MAX_ERROR_LENGTH),
                    branch: branchName,
                    developer: developer,
                    exitCode: code,
                    command: buildCommand
                };

                await saveLog(logEntry);
                vscode.window.showErrorMessage(`Build failed with exit code ${code}! Check dashboard for details.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error handling build result: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    buildProcess.on('error', (err) => {
        if (err.message.includes('ENOENT')) {
            if (err.message.includes('package.json')) {
                vscode.window.showErrorMessage(
                    `No package.json found in ${workspacePath}. Please open a project directory.`,
                    'Open Folder'
                ).then(selection => {
                    if (selection === 'Open Folder') {
                        vscode.commands.executeCommand('vscode.openFolder');
                    }
                });
            } else {
                vscode.window.showErrorMessage(
                    `Command not found. Please ensure your build tools are installed and in your PATH.`,
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'terminal.integrated.env');
                    }
                });
            }
        } else {
            vscode.window.showErrorMessage(`Build error: ${err.message}`);
        }
    });
}

function getValidatedBuildCommand(): string {
    const buildCommand = vscode.workspace.getConfiguration('build-logger').get<string>('buildCommand') || 'npm run build';

    // Basic validation - prevent empty or malicious commands
    if (!buildCommand.trim()) {
        throw new Error('Build command cannot be empty');
    }

    // Prevent obvious command injection
    if (buildCommand.includes(';') || buildCommand.includes('&&') || buildCommand.includes('||')) {
        throw new Error('Build command contains potentially dangerous characters');
    }

    if (buildCommand.startsWith('npm ')) {
        return `cd "${workspacePath}" && ${buildCommand}`;
    }

    return buildCommand;
}

function truncateString(str: string, maxLength: number): string {
    return str.length > maxLength ? str.substring(0, maxLength) + '... [truncated]' : str;
}

async function getGitBranch(): Promise<string> {
    try {
        const branch = await executeCommand('git rev-parse --abbrev-ref HEAD');
        return branch.trim() || 'unknown';
    } catch (error) {
        console.error(`Error getting git branch: ${error instanceof Error ? error.message : String(error)}`);
        return 'unknown';
    }
}

async function getDeveloperName(): Promise<string> {
    try {
        // Try to get user from git config first
        const gitName = await executeCommand('git config user.name');
        if (gitName.trim()) {
            return gitName.trim();
        }

        // Fallback to environment variables
        const username = process.env.USER || process.env.USERNAME ||
            process.env.LOGNAME || process.env.COMPUTERNAME || 'Unknown Developer';
        return username;
    } catch (error) {
        console.error(`Error getting developer name: ${error instanceof Error ? error.message : String(error)}`);
        return 'Unknown Developer';
    }
}

function executeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

async function saveLog(logEntry: object) {
    try {
        let logs: any[] = [];

        // Read existing logs if file exists
        if (fs.existsSync(logFilePath)) {
            try {
                const fileData = await fs.promises.readFile(logFilePath, 'utf8');
                logs = fileData ? JSON.parse(fileData) : [];
                if (!Array.isArray(logs)) {
                    logs = [];
                }
            } catch (error) {
                console.error(`Error parsing log file: ${error instanceof Error ? error.message : String(error)}`);
                logs = [];
            }
        }

        // Add new log entry and enforce maximum size
        logs.push(logEntry);
        if (logs.length > MAX_LOG_ENTRIES) {
            logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
        }

        // Write logs to file
        await fs.promises.writeFile(logFilePath, JSON.stringify(logs, null, 2));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Error saving build log: ${message}`);
        throw err;
    }
}

function showBuildDashboard() {
    try {
        const panel = vscode.window.createWebviewPanel(
            'buildLoggerDashboard',
            'Build Failure Dashboard',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.dirname(logFilePath))]
            }
        );

        loadAndDisplayLogs(panel);

        panel.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    switch (message.command) {
                        case "exportLogs":
                            await exportLogs();
                            break;
                        case "clearLogs":
                            await clearLogs();
                            loadAndDisplayLogs(panel); // Refresh the dashboard
                            break;
                        default:
                            console.warn(`Unknown command received: ${message.command}`);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Error handling dashboard command: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            },
            undefined,
            []
        );
    } catch (error) {
        vscode.window.showErrorMessage(
            `Failed to create build dashboard: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

async function loadAndDisplayLogs(panel: vscode.WebviewPanel) {
    try {
        let logs: any[] = [];

        if (fs.existsSync(logFilePath)) {
            const fileData = await fs.promises.readFile(logFilePath, 'utf8');
            logs = fileData ? JSON.parse(fileData) : [];
            if (!Array.isArray(logs)) {
                logs = [];
            }
        }

        panel.webview.html = generateDashboardHtml(logs);
    } catch (error) {
        console.error(`Error reading log file for dashboard: ${error instanceof Error ? error.message : String(error)}`);
        panel.webview.html = generateErrorHtml(
            'Failed to load logs',
            error instanceof Error ? error.message : String(error)
        );
    }
}

function generateDashboardHtml(logs: any[]): string {
    const failedBuilds = logs.length;

    // Group errors by type for display
    const errorCounts: { [key: string]: number } = {};
    const errorExamples: { [key: string]: string } = {};

    // Group by developer and branch for stats
    const developerStats: { [key: string]: number } = {};
    const branchStats: { [key: string]: number } = {};
    const commandStats: { [key: string]: number } = {};

    logs.forEach((log) => {

        const errorSig = log.error.split('\n').slice(0, 3).join('\n').trim();
        errorCounts[errorSig] = (errorCounts[errorSig] || 0) + 1;
        errorExamples[errorSig] = log.error;


        if (log.developer) {
            developerStats[log.developer] = (developerStats[log.developer] || 0) + 1;
        }


        if (log.branch) {
            branchStats[log.branch] = (branchStats[log.branch] || 0) + 1;
        }


        if (log.command) {
            commandStats[log.command] = (commandStats[log.command] || 0) + 1;
        }
    });


    const errorList = Object.entries(errorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([errorSig, count]) => {
            const fullError = errorExamples[errorSig];
            const shortError = escapeHtml(errorSig.length > 200
                ? errorSig.substring(0, 200) + '...'
                : errorSig);
            return `
                <li>
                    <details>
                        <summary><strong>${count}x</strong> ${shortError}</summary>
                        <pre class="error-details">${escapeHtml(fullError)}</pre>
                    </details>
                </li>
            `;
        })
        .join('');


    const developerList = Object.entries(developerStats)
        .sort((a, b) => b[1] - a[1])
        .map(([developer, count]) => `<li><strong>${escapeHtml(developer)}:</strong> ${count} failures</li>`)
        .join('');


    const branchList = Object.entries(branchStats)
        .sort((a, b) => b[1] - a[1])
        .map(([branch, count]) => `<li><strong>${escapeHtml(branch)}:</strong> ${count} failures</li>`)
        .join('');


    const commandList = Object.entries(commandStats)
        .sort((a, b) => b[1] - a[1])
        .map(([cmd, count]) => `<li><strong>${escapeHtml(cmd)}:</strong> ${count} failures</li>`)
        .join('');

    return `
        <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Build Failure Dashboard</title>
    <style>
        :root {
            --primary-color: #007acc;
            --secondary-color: #005f99;
            --background-light: #f4f4f4;
            --background-dark: #1e1e1e;
            --card-bg: #ffffff;
            --text-color: #333;
            --shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: var(--background-light);
            color: var(--text-color);
            margin: 0;
            padding: 20px;
            transition: all 0.3s ease-in-out;
        }
        h2 {
            color: var(--primary-color);
            border-bottom: 3px solid var(--primary-color);
            padding-bottom: 10px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
        }
        .stats, .stats-card, li {
            background-color: var(--card-bg);
            padding: 15px;
            border-radius: 8px;
            box-shadow: var(--shadow);
            transition: transform 0.2s ease-in-out;
        }
        .stats:hover, .stats-card:hover, li:hover {
            transform: translateY(-3px);
        }
        .stats {
            margin-bottom: 20px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        ul {
            list-style: none;
            padding: 0;
        }
        li {
            margin-bottom: 8px;
            padding: 10px;
        }
        button {
            padding: 12px 24px;
            background: var(--primary-color);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            transition: background 0.3s ease, transform 0.2s ease;
        }
        button:hover {
            background: var(--secondary-color);
            transform: scale(1.05);
        }
        .button-group {
            margin-top: 20px;
            display: flex;
            gap: 15px;
        }
        .error-details {
            white-space: pre-wrap;
            background-color: #f8f8f8;
            padding: 10px;
            border-radius: 4px;
            margin-top: 5px;
            max-height: 300px;
            overflow: auto;
        }
        details summary {
            cursor: pointer;
            font-weight: bold;
        }
        @media (prefers-color-scheme: dark) {
            body {
                background-color: var(--background-dark);
                color: #ddd;
            }
            .stats, .stats-card, li {
                background-color: #252526;
                color: #ddd;
            }
            .error-details {
                background-color: #333;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>Build Failure Dashboard</h2>
        <div class="stats">
            <p><strong>Total Failed Builds:</strong> ${failedBuilds}</p>
            ${failedBuilds > MAX_LOG_ENTRIES
            ? `<p class="warning">Showing most recent ${MAX_LOG_ENTRIES} entries (log rotation active)</p>`
            : ''}
        </div>
        <div class="stats-grid">
            <div class="stats-card">
                <h3>Developer Statistics</h3>
                <ul>${developerList || `<li>No developer data available</li>`}</ul>
            </div>
            <div class="stats-card">
                <h3>Branch Statistics</h3>
                <ul>${branchList || `<li>No branch data available</li>`}</ul>
            </div>
            <div class="stats-card">
                <h3>Command Statistics</h3>
                <ul>${commandList || `<li>No command data available</li>`}</ul>
            </div>
        </div>
        <h3>Most Common Errors (Top 20)</h3>
        <ul>${errorList || "No errors logged yet."}</ul>
        <div class="button-group">
            <button id="exportLogs">Export Logs</button>
            <button id="clearLogs">Clear All Logs</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById("exportLogs").addEventListener("click", () => {
            vscode.postMessage({ command: "exportLogs" });
        });
        document.getElementById("clearLogs").addEventListener("click", () => {
            if (confirm("Are you sure you want to clear all logs? This cannot be undone.")) {
                vscode.postMessage({ command: "clearLogs" });
            }
        });
    </script>
</body>
</html>`;
}

function generateErrorHtml(title: string, message: string): string {
    return `
<!DOCTYPE html>
<html>
    <head>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                padding: 20px;
                color: #ff4444;
            }
        </style>
    </head>
    <body>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
    </body>
</html>
    `;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
        .replace(/\n/g, "<br>");
}

async function exportLogs() {
    try {
        if (!fs.existsSync(logFilePath)) {
            vscode.window.showWarningMessage('No logs available to export');
            return;
        }

        const fileUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(workspacePath, 'build_logs_export.json')),
            filters: { 'JSON': ['json'] }
        });

        if (fileUri) {
            await fs.promises.copyFile(logFilePath, fileUri.fsPath);
            vscode.window.showInformationMessage(`Logs exported to: ${fileUri.fsPath}`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to export logs: ${message}`);
    }
}

async function clearLogs() {
    try {
        await fs.promises.writeFile(logFilePath, JSON.stringify([], null, 2));
        vscode.window.showInformationMessage('Build logs cleared successfully');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clear logs: ${message}`);
    }
}

export function deactivate() {
    if (buildTerminal) {
        buildTerminal.dispose();
    }
}