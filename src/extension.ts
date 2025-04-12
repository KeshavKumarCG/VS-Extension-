import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec, ExecException } from 'child_process';

// Constants
const MAX_LOG_ENTRIES = 1000;
const MAX_ERROR_LENGTH = 5000;
const SIGNIFICANT_CHANGE_THRESHOLD = 0.1; // 10% of code changes are significant

// Global variables
let workspacePath: string;
let logFilePath: string;
let buildTerminal: vscode.Terminal | undefined;
let statusBarItem: vscode.StatusBarItem;
let commitHookDisposable: vscode.Disposable | undefined;

// Interfaces
interface FileChange {
    file: string;
    additions: number;
    deletions: number;
}

interface LogEntry {
    timestamp: string;
    error: string;
    branch: string;
    developer: string;
    exitCode: number | null;
    command: string;
    workingDirectory: string;
    buildTime: number;
}

// Helper functions
function updateStatusBarItem(): void {
    statusBarItem.text = commitHookDisposable 
        ? '$(check) Build-on-Commit' 
        : '$(circle-slash) Build-on-Commit';
    statusBarItem.tooltip = commitHookDisposable
        ? 'Commit-triggered builds are enabled'
        : 'Commit-triggered builds are disabled';
    statusBarItem.show();
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

function ensureLogDirectoryExists(): void {
    const logDir = path.dirname(logFilePath);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
}

// Main functions
export function activate(context: vscode.ExtensionContext): void {
    workspacePath = getCorrectWorkspacePath();
    
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'build-logger.enableCommitHooks';
    updateStatusBarItem();
    
    // Enable commit hooks if configured
    if (vscode.workspace.getConfiguration('build-logger').get<boolean>('enableCommitHooks')) {
        enableCommitHooks().catch(err => {
            console.error('Failed to enable commit hooks:', err);
        });
    }

    // Check for package.json
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

    // Initialize log file path
    const configLogPath = vscode.workspace.getConfiguration('build-logger').get<string>('logFilePath');
    logFilePath = configLogPath
        ? path.resolve(workspacePath, configLogPath)
        : path.join(workspacePath, 'build_logs.json');
    
    ensureLogDirectoryExists();
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('build-logger.trackBuilds', trackBuilds), 
        vscode.commands.registerCommand('build-logger.showDashboard', showBuildDashboard),
        vscode.commands.registerCommand('build-logger.exportLogs', exportLogs),
        vscode.commands.registerCommand('build-logger.enableCommitHooks', enableCommitHooks),
        vscode.commands.registerCommand('build-logger.disableCommitHooks', disableCommitHooks),
        statusBarItem
    );
}

async function trackBuilds(): Promise<void> {
    try {
        workspacePath = getCorrectWorkspacePath();
        if (!fs.existsSync(workspacePath)) {
            throw new Error('Invalid workspace path. Please open a project folder first.');
        }

        // Clean up any existing terminal
        if (buildTerminal) {
            buildTerminal.dispose();
        }

        vscode.window.showInformationMessage('Build Logger Activated - Tracking builds...');

        // Initialize log file path
        const configLogPath = vscode.workspace.getConfiguration('build-logger').get<string>('logFilePath');
        logFilePath = configLogPath
            ? path.resolve(workspacePath, configLogPath)
            : path.join(workspacePath, 'build_logs.json');

        ensureLogDirectoryExists();
        await runBuildProcess();
    } catch (error) {
        console.error('Error in trackBuilds:', error);
        vscode.window.showErrorMessage(
            `Failed to track builds: ${error instanceof Error ? error.message : String(error)}`,
            'Open Folder'
        ).then(selection => {
            if (selection === 'Open Folder') {
                vscode.commands.executeCommand('vscode.openFolder');
            }
        });
    }
}

// Commit hook functions
export function enableCommitHooks(): Promise<void> {
    return new Promise(async (resolve) => {
        if (commitHookDisposable) {
            resolve();
            return;
        }

        if (!await isGitRepository()) {
            vscode.window.showErrorMessage('Commit hooks require a Git repository');
            resolve();
            return;
        }

        commitHookDisposable = vscode.commands.registerCommand('git.commit', async () => {
            try {
                const hasSignificantChanges = await checkForSignificantChanges();
                if (!hasSignificantChanges) {
                    vscode.window.showInformationMessage('No significant code changes detected. Skipping pre-commit build.');
                    await vscode.commands.executeCommand('git.commit', '--quiet');
                    return;
                }

                const shouldRunBuild = await vscode.window.showInformationMessage(
                    'Significant code changes detected. Run build before commit?',
                    { modal: true },
                    'Yes', 'No'
                );

                if (shouldRunBuild === 'Yes') {
                    const success = await runPreCommitBuild();
                    if (!success) {
                        vscode.window.showErrorMessage('Build failed! Please fix the issues before committing.');
                        return;
                    }
                }

                await vscode.commands.executeCommand('git.commit', '--quiet');
            } catch (error) {
                console.error('Error in commit hook:', error);
                vscode.window.showErrorMessage(`Error in build check: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        updateStatusBarItem();
        resolve();
    });
}

export function disableCommitHooks(): void {
    if (commitHookDisposable) {
        commitHookDisposable.dispose();
        commitHookDisposable = undefined;
        updateStatusBarItem();
    }
}

async function isGitRepository(): Promise<boolean> {
    try {
        await executeCommand('git rev-parse --is-inside-work-tree');
        return true;
    } catch {
        return false;
    }
}

async function checkForSignificantChanges(): Promise<boolean> {
    try {
        const diffOutput = await executeCommand('git diff --cached --numstat');
        if (!diffOutput.trim()) return false;

        const changes: FileChange[] = diffOutput.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [additions, deletions, file] = line.split('\t');
                return {
                    file,
                    additions: parseInt(additions) || 0,
                    deletions: parseInt(deletions) || 0
                };
            });

        const codeFiles = changes.filter(change => 
            !change.file.endsWith('.md') && 
            !change.file.endsWith('.txt') &&
            !change.file.match(/\.(png|jpg|jpeg|gif|svg)$/i));

        if (codeFiles.length === 0) return false;

        const fullDiff = await executeCommand('git diff --cached -U0');
        const significantLines = fullDiff.split('\n')
            .filter(line => line.startsWith('+') && !line.startsWith('+++'))
            .filter(line => {
                const codeLine = line.substring(1).trim();
                return codeLine.length > 0 &&
                    !codeLine.startsWith('//') &&
                    !codeLine.startsWith('/*') &&
                    !codeLine.startsWith('*') &&
                    !codeLine.startsWith('#');
            }).length;

        const totalChanges = codeFiles.reduce((sum, change) => sum + change.additions + change.deletions, 0);
        const changeRatio = significantLines / Math.max(totalChanges, 1);

        return changeRatio >= SIGNIFICANT_CHANGE_THRESHOLD;
    } catch (error) {
        console.error('Error checking for significant changes:', error);
        return true;
    }
}

async function runPreCommitBuild(): Promise<boolean> {
    try {
        const startTime = Date.now();
        const buildCommand = getValidatedBuildCommand();

        const result = await new Promise<boolean>((resolve) => {
            const buildProcess = spawn(buildCommand, {
                shell: true,
                cwd: workspacePath,
                stdio: 'pipe'
            });

            let output = '';

            buildProcess.stdout.on('data', (data: Buffer) => output += data.toString());
            buildProcess.stderr.on('data', (data: Buffer) => output += data.toString());

            buildProcess.on('close', async (code: number | null) => {
                if (code === 0) {
                    resolve(true);
                } else {
                    const developer = await getDeveloperName().catch(() => 'pre-commit');

                    const logEntry: LogEntry = {
                        timestamp: new Date().toISOString(),
                        error: output.length > MAX_ERROR_LENGTH
                            ? output.substring(0, MAX_ERROR_LENGTH) + '... [truncated]'
                            : output,
                        branch: 'pre-commit',
                        developer,
                        exitCode: code,
                        command: buildCommand,
                        workingDirectory: workspacePath,
                        buildTime: Date.now() - startTime
                    };

                    await saveLog(logEntry).catch(e => console.error('Error saving pre-commit log:', e));
                    resolve(false);
                }
            });

            buildProcess.on('error', (err: Error) => {
                console.error('Pre-commit build error:', err);
                resolve(false);
            });
        });

        return result;
    } catch (error) {
        console.error('Error in pre-commit build:', error);
        return false;
    }
}

// ... [Rest of your functions with proper TypeScript typing]




async function runBuildProcess() {
    try {
        // Validate workspace path again (in case it changed)
        if (!workspacePath || !fs.existsSync(workspacePath)) {
            throw new Error('Invalid workspace path. Please open a project folder first.');
        }

        // Get and validate build command
        const buildCommand = getValidatedBuildCommand();
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? "cmd.exe" : "/bin/bash"; // Using bash instead of sh for better compatibility
        const shellArgs = isWindows ? ["/c"] : ["-c"];

        // Create terminal with proper environment
        buildTerminal = vscode.window.createTerminal({
            name: `Build Logger - ${path.basename(workspacePath)}`,
            shellPath: isWindows ? process.env.ComSpec || "cmd.exe" : shell,
            cwd: workspacePath,
            env: {
                ...process.env,
                FORCE_COLOR: '1',
                NODE_ENV: 'development',
                PATH: process.env.PATH // Ensure PATH is preserved
            }
        });

        buildTerminal.show();
        vscode.window.showInformationMessage(`Running build in: ${workspacePath}`);

        // Handle paths with spaces on Windows
        let finalCommand = buildCommand;
        if (isWindows && workspacePath.includes(' ')) {
            finalCommand = `cd "${workspacePath}" && ${buildCommand}`;
        }

        // Start build process
        const buildProcess = spawn(shell, [...shellArgs, finalCommand], {
            cwd: workspacePath,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let buildOutput = '';
        let outputTimer: NodeJS.Timeout;
        let processExited = false;

        const handleOutput = (data: Buffer) => {
            const text = data.toString();
            buildOutput += text;
        
            if (outputTimer) {
                clearTimeout(outputTimer);
            }
        
            outputTimer = setTimeout(() => {
                if (buildTerminal && !processExited) {
                    try {
                        const isWindows = process.platform === 'win32';
                        const sanitized = text.replace(/[^\x20-\x7E\r\n]/g, '');
                        
                        if (isWindows) {
                            const lines = sanitized.split(/\r?\n/);
                            for (const line of lines) {
                                if (line.trim()) {
                                    buildTerminal.sendText(line, true);
                                }
                            }
                        } else {
                            buildTerminal.sendText(`echo "${sanitized.replace(/"/g, '\\"')}"`, true);
                        }
                    } catch (error) {
                        console.error('Error sending output to terminal:', error);
                    }
                }
            }, 100);
        };

        buildProcess.stdout.on('data', handleOutput);
        buildProcess.stderr.on('data', handleOutput);

        buildProcess.on('exit', async (code) => {
            processExited = true;
            if (outputTimer) {
                clearTimeout(outputTimer);
            }

            try {
                if (code === 0) {
                    vscode.window.showInformationMessage("Build Successful ✅");
                } else {
                    const [branchName, developer] = await Promise.all([
                        getGitBranch().catch(() => 'unknown'),
                        getDeveloperName().catch(() => 'Unknown Developer')
                    ]);

                    await saveLog({
                        timestamp: new Date().toISOString(),
                        error: truncateString(buildOutput.trim(), MAX_ERROR_LENGTH),
                        branch: branchName,
                        developer: developer,
                        exitCode: code,
                        command: buildCommand,
                        workingDirectory: workspacePath,
                        buildTime: Date.now()
                    });

                    vscode.window.showErrorMessage(`Build failed with exit code ${code}! Check dashboard for details.`);
                }
            } catch (error) {
                console.error('Error handling build result:', error);
                vscode.window.showErrorMessage(`Error processing build result: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        buildProcess.on('error', (err) => {
            processExited = true;
            console.error('Build process error:', err);
            handleBuildError(err);
        });

        buildProcess.on('close', () => {
            processExited = true;
            if (outputTimer) {
                clearTimeout(outputTimer);
            }
        });

    } catch (error) {
        console.error('Error in runBuildProcess:', error);
        handleBuildError(error);
    }
}

function handleBuildError(error: unknown) {
    let errorMessage = error instanceof Error ? error.message : String(error);

    if (error instanceof Error && 'message' in error) {
        if (error.message.includes('ENOENT')) {
            if (error.message.includes('package.json')) {
                errorMessage = `No package.json found in workspace. Please open a project directory.`;
            } else if (error.message.includes('npm') || error.message.includes('yarn') ||
                error.message.includes('mvn') || error.message.includes('gradle')) {
                errorMessage = `Build tool not found. Please ensure it's installed and in your PATH.`;
            }
        }
    }

    vscode.window.showErrorMessage(`Build error: ${errorMessage}`, 'Open Folder', 'Open Settings')
        .then(selection => {
            if (selection === 'Open Folder') {
                vscode.commands.executeCommand('vscode.openFolder');
            } else if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'terminal.integrated.env');
            }
        });
}


function getValidatedBuildCommand(): string {
    let buildCommand = vscode.workspace.getConfiguration('build-logger').get<string>('buildCommand') || '';
    const isWindows = process.platform === 'win32';

    if (!buildCommand.trim()) {
        if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
            buildCommand = isWindows ? 'npm.cmd run build' : 'npm run build';
        } else if (fs.existsSync(path.join(workspacePath, 'pom.xml'))) {
            buildCommand = 'mvn clean install';
        } else if (fs.existsSync(path.join(workspacePath, 'build.gradle'))) {
            buildCommand = isWindows ? 'gradlew.bat build' : './gradlew build';
        } else {
            throw new Error('No build system detected and no build command configured');
        }
    }

    buildCommand = buildCommand.trim();
    if (!buildCommand) {
        throw new Error('Build command cannot be empty');
    }

    // Security checks
    const dangerousPatterns = [';', '&&', '||', '`', '$('];
    if (dangerousPatterns.some(pattern => buildCommand.includes(pattern))) {
        throw new Error('Build command contains potentially dangerous characters');
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

async function saveLog(logEntry: any) {
    try {
        // Ensure log directory exists
        const logDir = path.dirname(logFilePath);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        // Read existing logs
        let logs: any[] = [];
        if (fs.existsSync(logFilePath)) {
            try {
                const fileData = await fs.promises.readFile(logFilePath, 'utf8');
                logs = fileData ? JSON.parse(fileData) : [];
                if (!Array.isArray(logs)) {
                    logs = [];
                }
            } catch (error) {
                console.error('Error parsing log file:', error);
                logs = [];
            }
        }

        // Add new log entry with additional metadata
        const enhancedEntry = {
            ...logEntry,
            extensionVersion: vscode.extensions.getExtension('KeshavKumar.build-logger')?.packageJSON.version || 'unknown',
            vscodeVersion: vscode.version,
            platform: process.platform
        };

        logs.push(enhancedEntry);

        // Enforce maximum log size
        if (logs.length > MAX_LOG_ENTRIES) {
            logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
        }

        // Write logs to file with error recovery
        const tempPath = logFilePath + '.tmp';
        await fs.promises.writeFile(tempPath, JSON.stringify(logs, null, 2));
        await fs.promises.rename(tempPath, logFilePath);

    } catch (err) {
        console.error('Error saving log:', err);
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
                            const success = await clearLogs();
                            if (success) {
                                // Refresh the dashboard after clearing logs
                                loadAndDisplayLogs(panel);
                            }
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
    (function() {
        const vscode = acquireVsCodeApi();
        document.getElementById("exportLogs").addEventListener("click", () => {
            vscode.postMessage({ command: "exportLogs" });
        });
        document.getElementById("clearLogs").addEventListener("click", () => {
            if (confirm("Are you sure you want to clear all logs? This cannot be undone.")) {
                vscode.postMessage({ command: "clearLogs" });
            }
        });
    })();
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

async function clearLogs(): Promise<boolean> {
    try {
        await fs.promises.writeFile(logFilePath, JSON.stringify([], null, 2));
        vscode.window.showInformationMessage('Build logs cleared successfully');
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clear logs: ${message}`);
        return false;
    }
}

function normalizePath(pathString: string): string {
    // Convert to forward slashes and remove duplicate slashes
    return pathString.replace(/\\/g, '/').replace(/\/+/g, '/');
}

async function checkBuildTools(): Promise<boolean> {
    try {
        const buildCommand = getValidatedBuildCommand();
        if (buildCommand.includes('npm') || buildCommand.includes('yarn')) {
            await executeCommand('npm --version');
            return true;
        } else if (buildCommand.includes('mvn')) {
            await executeCommand('mvn --version');
            return true;
        } else if (buildCommand.includes('gradle')) {
            await executeCommand('gradle --version');
            return true;
        }
        return true;
    } catch (error) {
        console.error('Build tools check failed:', error);
        return false;
    }
}

export function deactivate(): void {
    if (commitHookDisposable) {
        commitHookDisposable.dispose();
    }
    
    if (buildTerminal) {
        try {
            buildTerminal.sendText('exit', true);
            buildTerminal.dispose();
        } catch (error) {
            console.error('Error disposing terminal:', error);
        }
    }
}