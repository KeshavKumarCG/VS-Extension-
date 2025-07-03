import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn, exec } from "child_process";

import { uploadToFirebase } from "./firebaseService";
import { getGitRemoteUrl } from "./utils/gitUtils";

const MAX_LOG_ENTRIES = 1000;
const MAX_ERROR_LENGTH = 5000;

let workspacePath: string;
let logFilePath: string;
let buildTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
  const trackBtn = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101
  );
  trackBtn.command = "build-logger.trackBuilds";
  trackBtn.text = "$(debug-start) Track Builds";
  trackBtn.tooltip = "Start tracking builds";
  trackBtn.show();

  const dashboardBtn = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  dashboardBtn.command = "build-logger.showDashboard";
  dashboardBtn.text = "$(graph) Build Logger";
  dashboardBtn.tooltip = "Open Build Logger Dashboard";
  dashboardBtn.show();

  context.subscriptions.push(trackBtn, dashboardBtn);

  workspacePath = getCorrectWorkspacePath();

  if (!fs.existsSync(path.join(workspacePath, "package.json"))) {
    vscode.window
      .showWarningMessage(
        "Build Logger: No package.json found in current workspace. Some features may not work properly.",
        "Open Project Folder"
      )
      .then((selection) => {
        if (selection === "Open Project Folder") {
          vscode.commands.executeCommand("vscode.openFolder");
        }
      });
  }

  // Get log file path from configuration or use default
  const configLogPath = vscode.workspace
    .getConfiguration("build-logger")
    .get<string>("logFilePath");
  logFilePath = configLogPath
    ? path.resolve(workspacePath, configLogPath)
    : path.join(workspacePath, "build_logs.json");

  ensureLogDirectoryExists();

  // Register commands

  context.subscriptions.push(
    vscode.commands.registerCommand("build-logger.trackBuilds", trackBuilds),
    vscode.commands.registerCommand(
      "build-logger.showDashboard",
      showBuildDashboard
    ),
    vscode.commands.registerCommand("build-logger.exportLogs", exportLogs),
    vscode.commands.registerCommand(
      "build-logger.analyzeWithAI",
      analyzeErrorWithAI
    )
  );
}

async function analyzeErrorWithAI(errorContent?: string) {
  try {
    // Get API key from configuration
    const apiKey = vscode.workspace
      .getConfiguration("build-logger")
      .get<string>("geminiApiKey");
    if (!apiKey) {
      vscode.window.showErrorMessage(
        "Google Gemini API key not configured. Please set it in settings."
      );
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "build-logger.geminiApiKey"
      );
      return;
    }

    // If no error content provided, try to get it from active selection
    if (!errorContent) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selection = editor.selection;
        errorContent = editor.document.getText(selection);
      }
    }

    // If still no content, prompt user
    if (!errorContent) {
      errorContent = await vscode.window.showInputBox({
        prompt: "Enter the error message to analyze",
        placeHolder: "Paste the error message here...",
      });
    }

    if (!errorContent) {
      return; // User cancelled
    }

    // Show progress
    const progressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: "Analyzing error with Gemini AI...",
      cancellable: false,
    };

    const analysis = await vscode.window.withProgress(
      progressOptions,
      async () => {
        return await getAIErrorAnalysis(apiKey, errorContent!);
      }
    );

    // Show results in a new document
    const doc = await vscode.workspace.openTextDocument({
      content: `# Error Analysis\n\n## Original Error:\n\`\`\`\n${errorContent}\n\`\`\`\n\n## AI Analysis:\n${analysis}`,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc);
  } catch (error) {
    console.error("Error in analyzeErrorWithAI:", error);
    vscode.window.showErrorMessage(
      `Failed to analyze error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function getAIErrorAnalysis(
  apiKey: string,
  errorContent: string
): Promise<string> {
  try {
    // Using fetch API for direct HTTP request to Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `
                            Analyze this build error and provide:
                            1. A concise explanation of the likely cause
                            2. Step-by-step solutions to fix it
                            3. Any relevant best practices to prevent it
                            
                            Format the response in clear markdown with appropriate headings.
                            
                            Error:
                            ${errorContent}
                            `,
                },
              ],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorData}`);
    }

    const data = (await response.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
    };
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("Gemini API error:", error);
    throw new Error(
      `AI analysis failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function ensureLogDirectoryExists() {
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

async function trackBuilds() {
  try {
    // Get workspace path
    workspacePath = getCorrectWorkspacePath();

    // Validate workspace
    if (!workspacePath || !path.isAbsolute(workspacePath)) {
      throw new Error("Invalid workspace path format");
    }

    if (!fs.existsSync(workspacePath)) {
      throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }

    const stat = fs.statSync(workspacePath);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${workspacePath}`);
    }

    // Update log file path
    const configLogPath = vscode.workspace
      .getConfiguration("build-logger")
      .get<string>("logFilePath");

    logFilePath = configLogPath
      ? path.resolve(workspacePath, configLogPath)
      : path.join(workspacePath, "build_logs.json");

    // Ensure log directory exists
    ensureLogDirectoryExists();

    // Test build command validation
    try {
      const buildCommand = getValidatedBuildCommand();
      vscode.window.showInformationMessage(
        `Build Logger Activated - Will run: ${buildCommand}`
      );
    } catch (error) {
      vscode.window.showWarningMessage(
        `Build command issue: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      // Don't return here, let user configure and try anyway
    }

    // Start the build process
    await runBuildProcess();
  } catch (error) {
    console.error("Error in trackBuilds:", error);

    let errorMessage = "Failed to track builds: ";
    if (error instanceof Error) {
      errorMessage += error.message;
    } else {
      errorMessage += String(error);
    }

    vscode.window
      .showErrorMessage(errorMessage, "Open Folder", "Configure", "Retry")
      .then((selection) => {
        switch (selection) {
          case "Open Folder":
            vscode.commands.executeCommand("vscode.openFolder");
            break;
          case "Configure":
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "build-logger"
            );
            break;
          case "Retry":
            setTimeout(() => trackBuilds(), 1000);
            break;
        }
      });
  }
}

function getCorrectWorkspacePath(): string {
  if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  // Fallback to active text editor path
  if (vscode.window.activeTextEditor) {
    const documentPath = vscode.window.activeTextEditor.document.uri.fsPath;
    return path.dirname(documentPath);
  }

  throw new Error(
    "No workspace folder found. Please open a project folder first."
  );
}

async function runBuildProcess() {
  try {
    // Validate workspace path
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(
        "Invalid workspace path. Please open a project folder first."
      );
    }

    // Get and validate build command
    const buildCommand = getValidatedBuildCommand();
    vscode.window.showInformationMessage(`Running: ${buildCommand}`);

    // Clean up any existing terminal
    if (buildTerminal) {
      buildTerminal.dispose();
      buildTerminal = undefined;
    }

    // Show progress notification instead of terminal
    const progressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: `Running: ${buildCommand}`,
      cancellable: true,
    };

    await vscode.window.withProgress(
      progressOptions,
      async (progress, token) => {
        return new Promise<void>((resolve, reject) => {
          progress.report({ message: "Starting build..." });

          const isWindows = process.platform === "win32";
          let shell: string;
          let shellArgs: string[];

          // Fixed shell handling for better command parsing
          if (isWindows) {
            shell = process.env.ComSpec || "cmd.exe";
            shellArgs = ["/d", "/s", "/c"];  // Added /d and /s flags for better parsing
          } else {
            shell = "/bin/bash";
            shellArgs = ["-c"];
          }

          // Enhanced environment setup
          const buildEnv = {
            ...process.env,
            PATH: process.env.PATH,
            // Ensure proper npm environment
            NODE_ENV: process.env.NODE_ENV || "production",
            // Force color output for better error messages
            FORCE_COLOR: "1",
            npm_config_color: "always"
          };

          const buildProcess = spawn(shell, [...shellArgs, buildCommand], {
            cwd: workspacePath,
            env: buildEnv,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: false
          });

          let buildOutput = "";
          let errorOutput = "";
          const startTime = Date.now();

          // Handle cancellation
          token.onCancellationRequested(() => {
            try {
              // Better process killing for Windows
              if (isWindows) {
                spawn("taskkill", ["/pid", buildProcess.pid?.toString() || "", "/t", "/f"]);
              } else {
                buildProcess.kill("SIGTERM");
                // Fallback to SIGKILL if needed
                setTimeout(() => {
                  if (!buildProcess.killed) {
                    buildProcess.kill("SIGKILL");
                  }
                }, 5000);
              }
            } catch (killError) {
              console.error("Error killing build process:", killError);
            }
            reject(new Error("Build cancelled by user"));
          });

          // Collect stdout with better encoding
          buildProcess.stdout.on("data", (data: Buffer) => {
            const text = data.toString("utf8");
            buildOutput += text;

            // Update progress with current output line
            const lastLine = text
              .split("\n")
              .filter((line) => line.trim())
              .pop();
            if (lastLine) {
              progress.report({
                message:
                  lastLine.substring(0, 50) +
                  (lastLine.length > 50 ? "..." : ""),
              });
            }
          });

          // Collect stderr with better encoding
          buildProcess.stderr.on("data", (data: Buffer) => {
            const text = data.toString("utf8");
            errorOutput += text;
            buildOutput += text;
          });

          // Handle process completion
          buildProcess.on("exit", async (code) => {
            const endTime = Date.now();
            const duration = endTime - startTime;

            try {
              if (code === 0) {
                progress.report({ message: "Build completed successfully!" });
                vscode.window.showInformationMessage(
                  `✅ Build Successful (${duration}ms)`
                );
                resolve();
              } else {
                // Build failed - IMMEDIATELY show error notification FIRST
                const errorMessage = `❌ Build failed with exit code ${code}! Duration: ${duration}ms`;
                console.error("Build failed:", errorMessage);
                
                // Show error notification immediately - this is the most important part
                vscode.window.showErrorMessage(
                  errorMessage,
                  "Show Error Details",
                  "Open Dashboard"
                ).then((selection) => {
                  if (selection === "Show Error Details") {
                    // Show error in a new document
                    vscode.workspace
                      .openTextDocument({
                        content: `Build Error Details\n==================\n\nCommand: ${buildCommand}\nExit Code: ${code}\nDuration: ${duration}ms\nTimestamp: ${new Date().toISOString()}\n\nOutput:\n${buildOutput}`,
                        language: "plaintext",
                      })
                      .then((doc) => {
                        vscode.window.showTextDocument(doc);
                      });
                  } else if (selection === "Open Dashboard") {
                    showBuildDashboard();
                  }
                });

                // Handle logging in background - don't await or let it block
                Promise.resolve().then(async () => {
                  try {
                    const [branchName, developer, repoUrl] = await Promise.all([
                      getGitBranch().catch(() => "unknown"),
                      getDeveloperName().catch(() => "Unknown Developer"),
                      getGitRemoteUrl(workspacePath).catch(() => "unknown"),
                    ]);

                    const logEntry = {
                      timestamp: new Date().toISOString(),
                      error: truncateString(
                        buildOutput.trim() || errorOutput.trim(),
                        MAX_ERROR_LENGTH
                      ),
                      branch: branchName,
                      developer: developer,
                      exitCode: code,
                      command: buildCommand,
                      workingDirectory: workspacePath,
                      buildTime: endTime,
                      duration: duration,
                      repoUrl: repoUrl,
                    };

                    // Save log and upload to Firebase
                    await saveLog(logEntry);
                    await uploadToFirebase(logEntry);
                  } catch (loggingError) {
                    console.error("Error logging build failure:", loggingError);
                  }
                });

                // Add a small delay to ensure the error notification is shown before rejecting
                setTimeout(() => {
                  reject(new Error(errorMessage));
                }, 100);
              }
            } catch (error) {
              console.error("Error handling build result:", error);
              // Show error notification for any unexpected errors
              vscode.window.showErrorMessage(`Build failed and error handling failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
              reject(error);
            }
          });

          // Handle process errors with better error messages
          buildProcess.on("error", (err) => {
            console.error("Build process error:", err);
            
            // Provide specific error message for common issues
            if (err.message.includes("ENOENT")) {
              const errorMsg = `Command not found: ${buildCommand}. Make sure npm is installed and in your PATH.`;
              vscode.window.showErrorMessage(errorMsg);
              reject(new Error(errorMsg));
            } else {
              // FIXED: Show error notification for process errors
              vscode.window.showErrorMessage(`Build process error: ${err.message}`);
              reject(err);
            }
          });
        });
      }
    );
  } catch (error) {
    console.error("Error in runBuildProcess:", error);
    
    // FIXED: Ensure error notification is always shown
    const errorMessage = error instanceof Error ? error.message : "Build process failed with unknown error";
    vscode.window.showErrorMessage(`Build failed: ${errorMessage}`);
    
    // Re-throw to allow caller to handle if needed
    throw error;
  }
}

function handleBuildError(error: unknown) {
  let errorMessage = error instanceof Error ? error.message : String(error);
  let suggestions: string[] = [];

  if (error instanceof Error) {
    if (error.message.includes("ENOENT")) {
      if (error.message.includes("npm")) {
        errorMessage = "npm is not installed or not in PATH.";
        suggestions = ["Install Node.js", "Check Environment"];
      } else if (error.message.includes("yarn")) {
        errorMessage = "yarn is not installed or not in PATH.";
        suggestions = ["Install Yarn", "Use npm instead"];
      } else if (error.message.includes("mvn")) {
        errorMessage = "Maven is not installed or not in PATH.";
        suggestions = ["Install Maven", "Check Environment"];
      } else if (error.message.includes("gradle")) {
        errorMessage = "Gradle is not installed or not in PATH.";
        suggestions = ["Install Gradle", "Check Environment"];
      } else {
        errorMessage = "Build tool not found in PATH.";
        suggestions = ["Check Installation", "Open Settings"];
      }
    } else if (error.message.includes("not found")) {
      suggestions = ["Configure Build Command", "Check package.json"];
    }
  }

  const actions =
    suggestions.length > 0 ? suggestions : ["Open Folder", "Open Settings"];

  vscode.window
    .showErrorMessage(`Build error: ${errorMessage}`, ...actions)
    .then((selection) => {
      switch (selection) {
        case "Open Folder":
          vscode.commands.executeCommand("vscode.openFolder");
          break;
        case "Open Settings":
        case "Check Environment":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "build-logger"
          );
          break;
        case "Install Node.js":
          vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/"));
          break;
        case "Install Yarn":
          vscode.env.openExternal(vscode.Uri.parse("https://yarnpkg.com/"));
          break;
        case "Install Maven":
          vscode.env.openExternal(
            vscode.Uri.parse("https://maven.apache.org/")
          );
          break;
        case "Install Gradle":
          vscode.env.openExternal(vscode.Uri.parse("https://gradle.org/"));
          break;
        case "Configure Build Command":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "build-logger.buildCommand"
          );
          break;
        case "Check package.json":
          const packageJsonPath = path.join(workspacePath, "package.json");
          if (fs.existsSync(packageJsonPath)) {
            vscode.workspace.openTextDocument(packageJsonPath).then((doc) => {
              vscode.window.showTextDocument(doc);
            });
          }
          break;
      }
    });
}

function getValidatedBuildCommand(): string {
  const config = vscode.workspace.getConfiguration("build-logger");
  let buildCommand = config.get<string>("buildCommand") || "";

  // If no custom command is set, auto-detect based on project files
  if (!buildCommand.trim()) {
    const packageJsonPath = path.join(workspacePath, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(packageJsonPath, "utf8")
        );
        const scripts = packageJson.scripts || {};

        // Check for common build scripts in order of preference
        if (scripts.build) {
          buildCommand = "npm run build";
        } else if (scripts.compile) {
          buildCommand = "npm run compile";
        } else if (scripts.dist) {
          buildCommand = "npm run dist";
        } else if (scripts.dev) {
          buildCommand = "npm run dev";
        } else {
          buildCommand = "npm install"; // Fallback to install
        }
      } catch (error) {
        console.warn("Could not parse package.json:", error);
        buildCommand = "npm install";
      }
    } else {
      // Check for other project types
      if (fs.existsSync(path.join(workspacePath, "pom.xml"))) {
        buildCommand = "mvn compile";
      } else if (fs.existsSync(path.join(workspacePath, "build.gradle"))) {
        buildCommand = "gradle build";
      } else if (fs.existsSync(path.join(workspacePath, "Makefile"))) {
        buildCommand = "make";
      } else {
        throw new Error(
          "No recognized project structure found. Please configure a build command in settings."
        );
      }
    }
  }

  // Validate the command exists in package.json if it's an npm script
  if (
    buildCommand.includes("npm run") ||
    buildCommand.includes("yarn") ||
    buildCommand.includes("pnpm")
  ) {
    const packageJsonPath = path.join(workspacePath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(packageJsonPath, "utf8")
        );
        const scripts = packageJson.scripts || {};
        const scriptName = buildCommand.split(" ").pop();

        if (scriptName && !scripts[scriptName]) {
          const availableScripts = Object.keys(scripts);
          if (availableScripts.length > 0) {
            throw new Error(
              `Script '${scriptName}' not found. Available scripts: ${availableScripts.join(
                ", "
              )}`
            );
          } else {
            throw new Error("No scripts found in package.json");
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          throw error;
        }
        console.warn("Could not validate package.json:", error);
      }
    }
  }

  return buildCommand;
}

function truncateString(str: string, maxLength: number): string {
  return str.length > maxLength
    ? str.substring(0, maxLength) + "... [truncated]"
    : str;
}

async function getGitBranch(): Promise<string> {
  try {
    const branch = await executeCommand("git rev-parse --abbrev-ref HEAD");
    return branch.trim() || "unknown";
  } catch (error) {
    console.error(
      `Error getting git branch: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return "unknown";
  }
}

async function getDeveloperName(): Promise<string> {
  try {
    // Try to get user from git config first
    const gitName = await executeCommand("git config user.name");
    if (gitName.trim()) {
      return gitName.trim();
    }

    // Fallback to environment variables
    const username =
      process.env.USER ||
      process.env.USERNAME ||
      process.env.LOGNAME ||
      process.env.COMPUTERNAME ||
      "Unknown Developer";
    return username;
  } catch (error) {
    console.error(
      `Error getting developer name: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return "Unknown Developer";
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
        const fileData = await fs.promises.readFile(logFilePath, "utf8");
        logs = fileData ? JSON.parse(fileData) : [];
        if (!Array.isArray(logs)) {
          logs = [];
        }
      } catch (error) {
        console.error("Error parsing log file:", error);
        logs = [];
      }
    }

    // Add new log entry with additional metadata
    const enhancedEntry = {
      ...logEntry,
      extensionVersion:
        vscode.extensions.getExtension("KeshavKumar.build-logger")?.packageJSON
          .version || "unknown",
      vscodeVersion: vscode.version,
      platform: process.platform,
    };

    logs.push(enhancedEntry);

    // Enforce maximum log size
    if (logs.length > MAX_LOG_ENTRIES) {
      logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
    }

    // Write logs to file with error recovery
    const tempPath = logFilePath + ".tmp";
    await fs.promises.writeFile(tempPath, JSON.stringify(logs, null, 2));
    await fs.promises.rename(tempPath, logFilePath);
  } catch (err) {
    console.error("Error saving log:", err);
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Error saving build log: ${message}`);
    throw err;
  }
}

function showBuildDashboard() {
  try {
    const panel = vscode.window.createWebviewPanel(
      "buildLoggerDashboard",
      "Build Logger Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.dirname(logFilePath))],
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
            case "analyzeError":
              // Handle the analyzeError command
              if (message.errorContent) {
                await analyzeErrorWithAI(message.errorContent);
              }
              break;
            default:
              console.warn(`Unknown command received: ${message.command}`);
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Error handling dashboard command: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      },
      undefined,
      []
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to create build dashboard: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function loadAndDisplayLogs(panel: vscode.WebviewPanel) {
  try {
    let logs: any[] = [];

    if (fs.existsSync(logFilePath)) {
      const fileData = await fs.promises.readFile(logFilePath, "utf8");
      logs = fileData ? JSON.parse(fileData) : [];
      if (!Array.isArray(logs)) {
        logs = [];
      }
    }

    panel.webview.html = generateDashboardHtml(logs);
  } catch (error) {
    console.error(
      `Error reading log file for dashboard: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    panel.webview.html = generateErrorHtml(
      "Failed to load logs",
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
    const errorSig = log.error.split("\n").slice(0, 3).join("\n").trim();
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
      const shortError = escapeHtml(
        errorSig.length > 200 ? errorSig.substring(0, 200) + "..." : errorSig
      );
      return `
            <li style="display: flex; justify-content: space-between; align-items: center;">
                <details style="flex-grow: 1; margin-right: 10px;">
                    <summary><strong>${count}x</strong> ${shortError}</summary>
                    <pre class="error-details">${escapeHtml(fullError)}</pre>
                </details>
                <button class="ai-analyze-btn" data-error="${escapeHtml(
                  encodeURIComponent(fullError)
                )}">
                   🧠 Analyze with AI
                </button>
            </li>
            `;
    })
    .join("");

  const developerList = Object.entries(developerStats)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([developer, count]) =>
        `<li><strong>${escapeHtml(developer)}:</strong> ${count} failures</li>`
    )
    .join("");

  const branchList = Object.entries(branchStats)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([branch, count]) =>
        `<li><strong>${escapeHtml(branch)}:</strong> ${count} failures</li>`
    )
    .join("");

  const commandList = Object.entries(commandStats)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([cmd, count]) =>
        `<li><strong>${escapeHtml(cmd)}:</strong> ${count} failures</li>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Build Logger Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet"/>
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet"/>
  <style>
    :root {
    --primary-dark: #1e1e2f;
    --hover-dark: #2c2c3d;
    --accent-dark: #333344;
    --accent-hover: #444455;
    --background: #2a2a2a;  /* Dark gray background */
    --card-bg: #3c3f41;     /* Darker gray card background */
    --text-color: #e0e0e0;  /* Light gray text */
    --text-secondary: #b0b0b0; /* Lighter gray for secondary text */
    --header-color: #e0e0e0; /* Light gray headers */
    --border: #555;         /* Darker border */
    --card-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1);
    --card-hover-shadow: 0 6px 12px rgba(0,0,0,0.1);
    --border-radius: 10px;

    --export-btn-bg: #4caf50;  /* Lighter green for export */
    --export-btn-hover-bg: #45a049;  /* Darker green on hover */
    --ai-btn-bg: #f39c12;  /* Yellow for AI analyze button */
    --ai-btn-hover-bg: #e67e22;  /* Darker yellow on hover */
    }

    * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    }

    body {
    padding: 32px;
    font-family: 'Roboto', sans-serif;
    background-color: var(--background);
    color: var(--text-color);
    }

    h2, h3 {
    color: var(--header-color);
    }

    h2 {
    font-size: 28px;
    margin-bottom: 20px;
    }

    h3 {
    font-size: 22px;
    margin-bottom: 16px;
    }

    .container {
    max-width: 1200px;
    margin: 0 auto;
    }

    .card {
    background-color: var(--card-bg);
    padding: 24px;
    border-radius: var(--border-radius);
    box-shadow: var(--card-shadow);
    margin-bottom: 30px;
    border: 1px solid var(--border);
    transition: all 0.3s ease;
    }

    .card:hover {
    box-shadow: var(--card-hover-shadow);
    transform: translateY(-2px);
    }

    .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 24px;
    margin-bottom: 32px;
    }

    ul {
    list-style: none;
    padding: 0;
    }

    li {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    transition: background 0.2s ease;
    display: flex;
    justify-content: space-between;
    align-items: center;
    }

    li:hover {
    background-color: rgba(0, 0, 0, 0.03);
    border-radius: 6px;
    }

.button{
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 24px;
    font-size: 16px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    color: white;
    transition: all 0.3s ease;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.2); /* Subtle shadow for depth */
}

.ai-analyze-btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 22px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    color: white;
    transition: all 0.3s ease;
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.2); /* Subtle shadow for depth */
}

.button {
    background: #007bff; /* Solid blue background */
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); /* Light shadow for subtle depth */
    color: white; /* Ensures the text is readable */
}

.button:hover {
    background: #0056b3; /* Darker blue on hover */
    transform: translateY(-2px); /* Slightly raise the button on hover */
    box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15); /* Stronger shadow on hover */
}


.ai-analyze-btn {
    background: #2c6b3e; /* Warm yellow gradient */
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); /* Light shadow for subtle depth */
}

.ai-analyze-btn:hover {
    background: #245a32; /* Darker green on hover */
    transform: translateY(-2px); /* Slightly raise the button on hover */
    box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15); /* Stronger shadow on hover */
}


    .material-icons {
    font-size: 18px;
    }

    .note {
    font-size: 14px;
    color: var(--text-secondary);
    margin-top: 12px;
    }

    .summary-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    }

    .error-summary {
    white-space: pre-wrap;
    font-family: 'Roboto Mono', monospace;
    background-color: #3e4346;
    border: 1px solid var(--border);
    padding: 16px;
    border-radius: var(--border-radius);
    max-height: 300px;
    overflow-y: auto;
    font-size: 14px;
    line-height: 1.6;
    }

    .error-count, .stats-value {
    font-weight: 500;
    color: #ccc;
    }

    .button-group {
    display: flex;
    gap: 16px;
    margin-top: 32px;
    }

    @media (max-width: 768px) {
    body {
      padding: 16px;
    }

    h2 {
      font-size: 24px;
    }

    h3 {
      font-size: 18px;
    }

    .card {
      padding: 20px;
    }

    .grid {
      gap: 16px;
    }
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>📊 Build Logger Dashboard</h2>

    <div class="card">
    <h3>📈 Build Summary</h3>
    <h4>❌ ${failedBuilds} failed builds</h4>
    </div>

    <div class="grid">
    <div class="card">
      <h3>👩‍💻 Developer Statistics</h3>
      <ul>${developerList || `<li>😕 No developer data available</li>`}</ul>
    </div>

    <div class="card">
      <h3>🌿 Branch Statistics</h3>
      <ul>${branchList || `<li>🌱 No branch data available</li>`}</ul>
    </div>

    <div class="card">
      <h3>🔧 Command Statistics</h3>
      <ul>${commandList || `<li>🤷‍♂️ No command data available</li>`}</ul>
    </div>
    </div>

    <div class="card">
    <h3>🐞Errors</h3>
    <ul>
      ${errorList || `<li>🎉 No errors logged yet</li>`}
    </ul>
    </div>

    <div class="button-group">
    <button class="button" id="exportLogs">
      Export Logs
    </button>
    </div>
  </div>

  <script>
    (function () {
    const vscode = acquireVsCodeApi();

    document.getElementById("exportLogs").addEventListener("click", () => {
      vscode.postMessage({ command: "exportLogs" });
    });

    document.querySelectorAll(".ai-analyze-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const errorContent = decodeURIComponent(btn.dataset.error || "");
        vscode.postMessage({
        command: "analyzeError",
        errorContent
        });
      });
    });
    })();
  </script>
</body>
</html>
`;
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
      vscode.window.showWarningMessage("No logs available to export");
      return;
    }

    const fileUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(workspacePath, "build_logs_export.json")
      ),
      filters: { JSON: ["json"] },
    });

    if (fileUri) {
      await fs.promises.copyFile(logFilePath, fileUri.fsPath);
      vscode.window.showInformationMessage(
        `Logs exported to: ${fileUri.fsPath}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to export logs: ${message}`);
  }
}

async function fetchWithTimeout(
  url: string,
  options: any,
  timeout = 10000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const response = await fetch(url, {
    ...options,
    signal: controller.signal,
  });

  clearTimeout(id);
  return response;
}

function normalizePath(pathString: string): string {
  return pathString.replace(/\\/g, "/").replace(/\/+/g, "/");
}

async function checkBuildTools(): Promise<boolean> {
  try {
    const buildCommand = getValidatedBuildCommand();
    if (buildCommand.includes("npm") || buildCommand.includes("yarn")) {
      await executeCommand("npm --version");
      return true;
    } else if (buildCommand.includes("mvn")) {
      await executeCommand("mvn --version");
      return true;
    } else if (buildCommand.includes("gradle")) {
      await executeCommand("gradle --version");
      return true;
    }
    return true;
  } catch (error) {
    console.error("Build tools check failed:", error);
    return false;
  }
}

export function deactivate() {
  try {
    if (buildTerminal) {
      try {
        buildTerminal.sendText("exit", true);
      } catch (error) {
        console.error("Error sending exit command:", error);
      }

      try {
        buildTerminal.dispose();
      } catch (error) {
        console.error("Error disposing terminal:", error);
      }
    }
  } catch (error) {
    console.error("Error in deactivate:", error);
  }
}
