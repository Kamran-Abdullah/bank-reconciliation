/**
 * Crash-Proof Server Wrapper
 * 
 * This wrapper runs the Next.js standalone server with:
 * - Global uncaught exception handling (prevents server crashes)
 * - Automatic restart on crash
 * - Detailed error logging
 * - Memory monitoring
 * - Folder rename/move portability (patches hardcoded paths at runtime)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LOG_FILE = path.join(__dirname, 'server_errors.log');

function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) {
        // If we can't write to the log file, just console output
    }
    console.log(line.trim());
}

// Prevent the process from ever dying from unhandled errors
process.on('uncaughtException', (err) => {
    log(`UNCAUGHT EXCEPTION: ${err.message}`);
    log(`Stack: ${err.stack}`);
    // Don't exit - keep the server alive
});

process.on('unhandledRejection', (reason, promise) => {
    log(`UNHANDLED REJECTION: ${reason}`);
    // Don't exit - keep the server alive
});

// Set higher memory limit for large file processing
const v8 = require('v8');
const heapStats = v8.getHeapStatistics();
log(`Node.js heap limit: ${Math.round(heapStats.heap_size_limit / 1024 / 1024)}MB`);

/**
 * Detect the build-time project root from any file in the standalone directory.
 * We look at required-server-files.json first (has appDir), then server.js.
 * Returns the old path that needs to be replaced, or null if none found.
 */
function detectBuildTimeRoot(standaloneDir) {
    // Strategy 1: Parse required-server-files.json for appDir
    const rsfPath = path.join(standaloneDir, '.next', 'required-server-files.json');
    if (fs.existsSync(rsfPath)) {
        try {
            const rsf = JSON.parse(fs.readFileSync(rsfPath, 'utf8'));
            if (rsf.appDir && rsf.appDir.length > 1) {
                // appDir is the project root at build time, e.g. "/home/user/my-project" or "C:\Users\..."
                const buildRoot = rsf.appDir.replace(/\\/g, '/');
                log(`Detected build-time root from appDir: ${buildRoot}`);
                return buildRoot;
            }
        } catch (e) {
            log(`Warning: Could not parse required-server-files.json: ${e.message}`);
        }
    }

    // Strategy 2: Scan server.js for any absolute path containing .next
    const serverJsPath = path.join(standaloneDir, 'server.js');
    if (fs.existsSync(serverJsPath)) {
        try {
            const content = fs.readFileSync(serverJsPath, 'utf8');
            // Match paths like "/home/user/project/.next" or "C:/Users/project/.next"
            const pattern = /["']([A-Za-z]:[\\\/][^"']*?|[\/][^"']*?)[\\\/]\.next/g;
            const m = pattern.exec(content);
            if (m) {
                const buildRoot = m[1].replace(/\\/g, '/');
                log(`Detected build-time root from server.js: ${buildRoot}`);
                return buildRoot;
            }
        } catch (e) {
            log(`Warning: Could not scan server.js: ${e.message}`);
        }
    }

    return null;
}

/**
 * Replace all occurrences of oldRoot with currentRoot in a string.
 * Handles both forward-slash and backslash versions of the path.
 */
function replaceRootInContent(content, oldRoot, currentRoot) {
    if (!oldRoot || oldRoot === currentRoot) return content;

    const normalizedOld = oldRoot.replace(/\\/g, '/');
    const normalizedCurrent = currentRoot.replace(/\\/g, '/');

    // Also create Windows backslash versions
    const winOld = normalizedOld.replace(/\//g, '\\');
    const winCurrent = normalizedCurrent.replace(/\//g, '\\');

    let result = content;

    // Replace forward-slash version
    if (normalizedOld !== normalizedCurrent) {
        const escapedFwd = normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escapedFwd, 'g'), normalizedCurrent);
    }

    // Replace backslash version (Windows paths in JSON may use \\)
    if (winOld !== winCurrent) {
        const escapedBack = winOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escapedBack, 'g'), winCurrent);
    }

    return result;
}

/**
 * Patch all files in the standalone directory that contain hardcoded paths.
 * This is the main portability fix.
 */
function patchAllPaths(standaloneDir) {
    const currentRoot = __dirname.replace(/\\/g, '/');
    const oldRoot = detectBuildTimeRoot(standaloneDir);

    if (!oldRoot || oldRoot === currentRoot) {
        log('No path patching needed — paths are already correct');
        return;
    }

    log(`Patching all paths: ${oldRoot} → ${currentRoot}`);

    // List of files to patch
    const filesToPatch = [
        path.join(standaloneDir, 'server.js'),
        path.join(standaloneDir, '.next', 'server', 'config.json'),
        path.join(standaloneDir, '.next', 'required-server-files.json'),
    ];

    // Also find any other .json files in .next that might contain paths
    const nextDir = path.join(standaloneDir, '.next');
    if (fs.existsSync(nextDir)) {
        try {
            const entries = fs.readdirSync(nextDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'config.json' && entry.name !== 'required-server-files.json') {
                    filesToPatch.push(path.join(nextDir, entry.name));
                }
                // Also check server subdirectory
                if (entry.isDirectory() && entry.name === 'server') {
                    const serverDir = path.join(nextDir, 'server');
                    try {
                        const serverEntries = fs.readdirSync(serverDir, { withFileTypes: true });
                        for (const se of serverEntries) {
                            if (se.isFile() && se.name.endsWith('.json')) {
                                filesToPatch.push(path.join(serverDir, se.name));
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    }

    // Also scan for route manifest files in deeper directories
    function findJsonFiles(dir, depth) {
        if (depth > 3) return; // Don't go too deep
        if (!fs.existsSync(dir)) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.json')) {
                    const fullPath = path.join(dir, entry.name);
                    if (!filesToPatch.includes(fullPath)) {
                        filesToPatch.push(fullPath);
                    }
                } else if (entry.isDirectory() && entry.name !== 'node_modules') {
                    findJsonFiles(path.join(dir, entry.name), depth + 1);
                }
            }
        } catch (e) { /* ignore */ }
    }

    findJsonFiles(path.join(standaloneDir, '.next', 'server'), 0);

    let patchedCount = 0;
    for (const filePath of filesToPatch) {
        if (!fs.existsSync(filePath)) continue;
        try {
            let content = fs.readFileSync(filePath, 'utf8');
            const newContent = replaceRootInContent(content, oldRoot, currentRoot);
            if (newContent !== content) {
                fs.writeFileSync(filePath, newContent, 'utf8');
                log(`Patched: ${path.relative(standaloneDir, filePath)}`);
                patchedCount++;
            }
        } catch (err) {
            log(`Warning: Could not patch ${path.basename(filePath)}: ${err.message}`);
        }
    }

    if (patchedCount > 0) {
        log(`Successfully patched ${patchedCount} file(s) for folder portability`);
    } else {
        log('No files needed patching');
    }
}

// Determine which server to run
const standaloneDir = path.join(__dirname, '.next', 'standalone');
const standaloneServer = path.join(standaloneDir, 'server.js');
const fallbackServer = path.join(__dirname, 'server.js');

let serverPath;
let serverCwd;

if (fs.existsSync(standaloneServer)) {
    serverPath = standaloneServer;
    serverCwd = standaloneDir;
    
    // Patch all hardcoded paths for folder portability
    patchAllPaths(standaloneDir);
    
    log('Using standalone server');
} else if (fs.existsSync(fallbackServer)) {
    serverPath = fallbackServer;
    serverCwd = __dirname;
    log('Using fallback server');
} else {
    log('ERROR: No server file found!');
    log('Looking for: ' + standaloneServer);
    log('Looking for: ' + fallbackServer);
    process.exit(1);
}

// Run the actual Next.js server as a child process
// This way, if it crashes, we can restart it
let serverProcess = null;
let restartCount = 0;
const MAX_RESTARTS = 5;

function startServer() {
    if (restartCount >= MAX_RESTARTS) {
        log(`Server crashed ${MAX_RESTARTS} times. Stopping restart attempts.`);
        log('Check server_errors.log for details.');
        return;
    }

    log(`Starting server (attempt ${restartCount + 1})...`);
    
    const env = { ...process.env, PORT: process.env.PORT || '3000', HOSTNAME: '0.0.0.0' };
    
    serverProcess = spawn(process.execPath, [serverPath], {
        cwd: serverCwd,
        env: env,
        stdio: 'inherit',
    });

    serverProcess.on('error', (err) => {
        log(`Server process error: ${err.message}`);
        restartCount++;
        setTimeout(startServer, 3000);
    });

    serverProcess.on('exit', (code, signal) => {
        log(`Server exited with code: ${code}, signal: ${signal}`);
        if (code !== 0 && code !== null) {
            restartCount++;
            log(`Restarting server in 3 seconds... (${restartCount}/${MAX_RESTARTS})`);
            setTimeout(startServer, 3000);
        }
    });
}

startServer();

// Graceful shutdown
process.on('SIGINT', () => {
    log('Received SIGINT. Shutting down...');
    if (serverProcess) serverProcess.kill('SIGINT');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('Received SIGTERM. Shutting down...');
    if (serverProcess) serverProcess.kill('SIGTERM');
    process.exit(0);
});
