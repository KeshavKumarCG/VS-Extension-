import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import { OllamaService } from './ollamaService';
import { uploadToFirebase } from './firebaseService';
import { getGitRemoteUrl } from './utils/gitUtils'; 

const MAX_LOG_ENTRIES = 1000;
const MAX_ERROR_LENGTH = 5000;
let ollamaService: OllamaService;

let workspacePath: string;
let logFilePath: string;
let buildTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
    ollamaService = new OllamaService(context);
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
    // In the activate function, change the command registration to:
    context.subscriptions.push(
        vscode.commands.registerCommand('build-logger.trackBuilds', trackBuilds),
        vscode.commands.registerCommand('build-logger.showDashboard', () => showBuildDashboard(context)),
        vscode.commands.registerCommand('build-logger.exportLogs', exportLogs),
        vscode.commands.registerCommand('build-logger.analyzeWithAI', analyzeBuildWithAI)
    );
}

async function analyzeBuildWithAI() {
    try {

        const aiAnalysisEnabled = vscode.workspace.getConfiguration('build-logger').get<boolean>('enableAIAnalysis', false);

        if (!aiAnalysisEnabled) {
            vscode.window.showErrorMessage(
                'AI analysis failed: Ollama integration is disabled in settings',
                'Open Settings'
            ).then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'build-logger.enableAIAnalysis');
                }
            });
            return;
        }

        if (!fs.existsSync(logFilePath)) {
            vscode.window.showWarningMessage('No build logs available for analysis');
            return;
        }

        const logs = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        if (!logs.length) {
            vscode.window.showWarningMessage('No build failures logged');
            return;
        }

        // Check if Ollama is available
          const isAvailable = await ollamaService.checkOllamaAvailable();
        if (!isAvailable) {
            vscode.window.showErrorMessage(
                'Ollama is not running. Please install and start Ollama first.',
                'Open Ollama Website'
            ).then(selection => {
                if (selection === 'Open Ollama Website') {
                    vscode.env.openExternal(vscode.Uri.parse('https://ollama.ai'));
                }
            });
            return;
        }

        // Let user select which failure to analyze
        const items: { label: string; description: string; detail: string; log: any }[] = logs.map((log: any, index: number) => ({
            label: `${log.timestamp} - ${log.command}`,
            description: `Exit code: ${log.exitCode}`,
            detail: log.error.substring(0, 100) + (log.error.length > 100 ? '...' : ''),
            log
        }));

        const selected: { label: string; description: string; detail: string; log: any } | undefined = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a build failure to analyze',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            return;
        }

        // Show progress while analyzing
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Analyzing build failure with AI",
            cancellable: false
        }, async () => {
            const analysis = await ollamaService.analyzeBuildFailure(selected.log.error);

            // Show results in a new document
            if (selected && selected.log) {
                const doc = await vscode.workspace.openTextDocument({
                    content: `# Build Failure Analysis\n\n` +
                        `**Timestamp:** ${selected.log.timestamp}\n` +
                        `**Command:** ${selected.log.command}\n` +
                        `**Exit Code:** ${selected.log.exitCode}\n\n` +
                        `## Error Analysis\n${analysis}`,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc);
            }

        });

    } catch (error) {
        vscode.window.showErrorMessage(
            `AI analysis failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
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
        // Verify workspace path is valid
        workspacePath = getCorrectWorkspacePath();
        if (!fs.existsSync(workspacePath)) {
            throw new Error('Invalid workspace path. Please open a project folder first.');
        }

        // Clean up any existing terminal
        if (buildTerminal) {
            buildTerminal.dispose();
        }

        vscode.window.showInformationMessage('Build Logger Activated - Tracking builds...');

        // Initialize log file path (in case it changed)
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
                    const [branchName, developer, repoUrl] = await Promise.all([
                        getGitBranch().catch(() => 'unknown'),
                        getDeveloperName().catch(() => 'Unknown Developer'),
                        getGitRemoteUrl(workspacePath).catch(() => 'unknown') // ✅ pass correct path
                    ]);            
                    console.log('Branch Name:', branchName);
                    console.log('Developer Name:', developer);  
                    console.log('Repository URL:', repoUrl);

                    await saveLog({
                        timestamp: new Date().toISOString(),
                        error: truncateString(buildOutput.trim(), MAX_ERROR_LENGTH),
                        branch: branchName,
                        developer: developer,
                        exitCode: code,
                        command: buildCommand,
                        workingDirectory: workspacePath,
                        buildTime: Date.now(),
                        repoUrl: repoUrl
                    });

                    await uploadToFirebase({
                        timestamp: new Date().toISOString(),
                        error: truncateString(buildOutput.trim(), MAX_ERROR_LENGTH),
                        branch: branchName,
                        developer: developer,
                        exitCode: code,
                        command: buildCommand,
                        workingDirectory: workspacePath,
                        buildTime: Date.now(),
                        repoUrl: repoUrl
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

function showBuildDashboard(context: vscode.ExtensionContext) {
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

        // Store the panel reference to refresh it later
        const refreshDashboard = () => {
            loadAndDisplayLogs(panel);
        };

        // Initial load
        refreshDashboard();

        // Add panel to subscriptions so it gets disposed when extension deactivates
        context.subscriptions.push(panel);

        panel.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    switch (message.command) {
                        case "exportLogs":
                            await exportLogs();
                            break;
                        case "analyzeError":
                            const logs = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
                            const logToAnalyze = logs.find((log: { error: string }) => log.error === message.error);
                            if (logToAnalyze) {
                                await analyzeBuildWithAI();
                            }
                            break;
                        case "clearLogs":
                            const success = await clearLogs();
                            if (success) {
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
            context.subscriptions
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
       <ul>
  ${logs.map(log => `
    <li>
        <strong>${log.message}</strong>
        <details class="error-details">
            <summary>Details</summary>
            ${escapeHtml(log.error)}
        </details>
        <button class="analyze-btn" style= "margin-top:5px" data-error="${escapeHtml(JSON.stringify(log.error))}">Analyze with AI</button>
        <div class="ai-response" style="margin-top: 10px;"></div>
    </li>
  `).join('') || "<li>No errors logged yet.</li>"}
</ul>

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

    document.querySelectorAll(".analyze-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const error = JSON.parse(btn.dataset.error);
            const responseDiv = btn.nextElementSibling;

            vscode.postMessage({
                command: "analyzeError",
                error: error
            });
            responseDiv.innerHTML = "Analyzing error with AI..."
        });
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
        const logDir = path.dirname(logFilePath);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const tempPath = logFilePath + '.tmp';
        await fs.promises.writeFile(tempPath, JSON.stringify([], null, 2));
        await fs.promises.rename(tempPath, logFilePath);

        vscode.window.showInformationMessage('Build logs cleared successfully');
        return true;
    } catch (err) {
        console.error('Error clearing logs:', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clear logs: ${message}`);
        return false;
    }
}
function normalizePath(pathString: string): string {
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

export function deactivate() {
    try {
        if (buildTerminal) {

            try {
                buildTerminal.sendText('exit', true);
            } catch (error) {
                console.error('Error sending exit command:', error);
            }

            try {
                buildTerminal.dispose();
            } catch (error) {
                console.error('Error disposing terminal:', error);
            }
        }
    } catch (error) {
        console.error('Error in deactivate:', error);
    }
}