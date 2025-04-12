import { exec } from 'child_process';
import * as util from 'util';
const execPromise = util.promisify(exec);

export async function getGitRemoteUrl(workspacePath: string): Promise<string> {
    try {
        const { stdout } = await execPromise('git remote -v', { cwd: workspacePath });

        // Debug log to check what is returned
        console.log('🔍 git remote -v output:', stdout);

        const match = stdout.match(/origin\s+(https?:\/\/[^\s]+)\s+\(fetch\)/);
        if (match) {
            return match[1];
        } else {
            console.warn('⚠️ Could not parse remote URL');
            return 'unknown';
        }
    } catch (error: any) {
        console.error('❌ Git remote fetch failed:', error.message || error);
        return 'unknown';
    }
}
