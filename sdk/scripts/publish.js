#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const versionFilePath = path.join(__dirname, '..', 'VERSION');
const version = fs.readFileSync(versionFilePath, 'utf8').trim();
const gitTag = `v${version}`;

// Determine npm dist-tag from version
// e.g., "2.155.0-beta.7" -> "beta", "2.155.0-alpha.1" -> "alpha", "2.155.0" -> "latest"
function getDistTag(version) {
    const match = version.match(/-([a-zA-Z]+)/);
    if (match) {
        return match[1]; // e.g., "beta", "alpha", "rc"
    }
    return 'latest';
}

const distTag = getDistTag(version);

console.log(`📦 Publishing version: ${version}`);
console.log(`🏷️  Git tag: ${gitTag}`);
console.log(`📌 npm dist-tag: ${distTag}`);
console.log('');

function run(cmd, options = {}) {
    console.log(`> ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', ...options });
    } catch (error) {
        console.error(`❌ Command failed: ${cmd}`);
        process.exit(1);
    }
}

// Check for uncommitted changes
try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    if (status.trim()) {
        console.error('❌ You have uncommitted changes. Please commit or stash them first.');
        process.exit(1);
    }
} catch (error) {
    console.error('❌ Failed to check git status');
    process.exit(1);
}

// Check if tag already exists
try {
    execSync(`git rev-parse ${gitTag}`, { stdio: 'pipe' });
    console.error(`❌ Git tag ${gitTag} already exists. Bump the version first.`);
    process.exit(1);
} catch (error) {
    // Tag doesn't exist, which is what we want
}

// Create and push git tag
console.log('\n📝 Creating git tag...');
run(`git tag ${gitTag}`);

console.log('\n🚀 Pushing git tag...');
run(`git push origin ${gitTag}`);

// Publish to npm
console.log('\n📦 Publishing to npm...');
run(`npm publish --access public --tag ${distTag}`);

console.log(`\n✅ Successfully published ${version} to npm with tag "${distTag}"`);
console.log(`   Git tag: ${gitTag}`);
