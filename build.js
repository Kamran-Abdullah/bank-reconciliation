const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Run Next.js build
console.log('Building Next.js application...');
execSync('npx next build', { stdio: 'inherit' });

// Verify standalone output was generated
const standaloneDir = path.join(__dirname, '.next', 'standalone');
const serverFile = path.join(standaloneDir, 'server.js');

if (!fs.existsSync(serverFile)) {
    console.error('');
    console.error('============================================');
    console.error('  ERROR: Standalone server.js was NOT generated!');
    console.error('============================================');
    console.error('');
    console.error('  Trying alternative: running with next start...');
    console.error('');
    
    // Fallback: create a simple server.js that uses next start
    const fallbackServer = `const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');

const app = next({ dev: false });
const handle = app.getRequestHandler();

app.prepare().then(() => {
    createServer((req, res) => {
        const parsedUrl = parse(req.url, true);
        handle(req, res, parsedUrl);
    }).listen(3000, () => {
        console.log('> Server running on http://localhost:3000');
    });
});
`;
    fs.writeFileSync(path.join(__dirname, 'server.js'), fallbackServer);
    console.log('  Created fallback server.js');
    console.log('');
    process.exit(0);
}

function copyRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) {
        console.log(`Warning: Source path does not exist: ${src}`);
        return;
    }

    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            // Skip huge unnecessary directories
            if (entry.name === '.cache' || entry.name === '.git' || entry.name === 'test' || entry.name === 'tests') continue;
            copyRecursiveSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Copy static files and public folder to standalone output
console.log('Copying static files to standalone output...');
copyRecursiveSync(
    path.join(__dirname, '.next', 'static'),
    path.join(standaloneDir, '.next', 'static')
);

console.log('Copying public folder to standalone output...');
copyRecursiveSync(
    path.join(__dirname, 'public'),
    path.join(standaloneDir, 'public')
);

// Ensure critical node_modules are available in standalone output
// The standalone build should include these, but sometimes it misses packages
// that are listed in serverExternalPackages
const standaloneNodeModules = path.join(standaloneDir, 'node_modules');
const rootNodeModules = path.join(__dirname, 'node_modules');

// List of packages that MUST be available (especially xlsx which is external)
const criticalPackages = ['xlsx'];

for (const pkg of criticalPackages) {
    const standalonePkgPath = path.join(standaloneNodeModules, pkg);
    const rootPkgPath = path.join(rootNodeModules, pkg);
    
    if (!fs.existsSync(standalonePkgPath) && fs.existsSync(rootPkgPath)) {
        console.log(`Copying missing package to standalone: ${pkg}`);
        copyRecursiveSync(rootPkgPath, standalonePkgPath);
    } else if (fs.existsSync(standalonePkgPath)) {
        console.log(`[OK] Package already in standalone: ${pkg}`);
    } else {
        console.log(`[WARNING] Package not found anywhere: ${pkg}`);
    }
}

// Verify critical files exist
const criticalFiles = [
    { path: path.join(standaloneDir, 'server.js'), name: 'server.js' },
    { path: path.join(standaloneDir, '.next', 'static'), name: '.next/static' },
];

let allGood = true;
for (const file of criticalFiles) {
    if (fs.existsSync(file.path)) {
        console.log(`[OK] ${file.name} exists`);
    } else {
        console.log(`[MISSING] ${file.name} not found!`);
        allGood = false;
    }
}

// Check xlsx specifically
const xlsxInStandalone = fs.existsSync(path.join(standaloneNodeModules, 'xlsx'));
console.log(`[CHECK] xlsx in standalone node_modules: ${xlsxInStandalone ? 'YES' : 'NO'}`);

console.log('');
if (allGood) {
    console.log('Build completed successfully!');
    console.log('Server file: ' + serverFile);
    console.log('');
    console.log('To start the server, run:');
    console.log('  node crashproof-server.js');
    console.log('  OR');
    console.log('  node .next/standalone/server.js');
} else {
    console.log('Build completed with warnings.');
    console.log('Some files may be missing. The fallback server may be needed.');
}
