import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export class OllamaService {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    private getConfig() {
        const config = vscode.workspace.getConfiguration('build-logger.ollama');
        return {
            host: config.get<string>('host') || 'http://localhost:11434',
            model: config.get<string>('model') || 'llama3',
            enabled: config.get<boolean>('enabled') || false
        };
    }

    public async analyzeBuildFailure(error: string): Promise<string> {
        const config = this.getConfig();
        if (!config.enabled) {
            throw new Error('Ollama integration is disabled in settings');
        }

        try {
            const prompt = `
            Analyze this build error and provide:
            1. A concise explanation of the likely cause
            2. 2-3 specific suggestions to fix it
            3. Any relevant documentation links if available

            Build error:
            ${error}
            `;

            const response = await this.makeOllamaRequest(config.host, config.model, prompt);
            return response.response;
        } catch (error) {
            console.error('Ollama error:', error);
            throw new Error(`Failed to analyze build error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public async checkOllamaAvailable(): Promise<boolean> {
        try {
            const config = this.getConfig();
            const response = await this.makeHttpRequest(`${config.host}/api/tags`, 'GET');
            return !!response; // Return true if we get a successful response
        } catch (error) {
            console.error('Ollama availability check failed:', error);
            return false;
        }
    }

    private async makeOllamaRequest(host: string, model: string, prompt: string): Promise<any> {
        const payload = {
            model: model,
            prompt: prompt,
            stream: false
        };

        const response = await this.makeHttpRequest(`${host}/api/generate`, 'POST', payload);
        return JSON.parse(response);
    }

    private makeHttpRequest(url: string, method: string, data?: any): Promise<string> {
        return new Promise((resolve, reject) => {
            const isHttps = url.startsWith('https');
            const requestModule = isHttps ? https : http;
            const urlObj = new URL(url);
            
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                }
            };

            const req = requestModule.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`HTTP Error: ${res.statusCode} - ${data}`));
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            if (data) {
                req.write(JSON.stringify(data));
            }
            
            req.end();
        });
    }
}