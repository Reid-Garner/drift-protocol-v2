#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const skipChecks = process.argv.includes('--skip-checks');

const versionFilePath = path.join(__dirname, '..', 'VERSION');
const version = fs.readFileSync(versionFilePath, 'utf8').trim();
const gitTag = `v${version}`;

// Derive npm dist-tag from version
// e.g., "2.155.0-beta.7" -> "beta", "2.155.0-rc.1" -> "rc", "2.155.0" -> "latest"
function getDistTag(version) {
	const match = version.match(/-([a-zA-Z]+)/);
	if (match) {
		return match[1];
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
if (!skipChecks) {
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
}

// Check if tag already exists
let tagExists = false;
try {
	execSync(`git rev-parse ${gitTag}`, { stdio: 'pipe' });
	tagExists = true;
} catch (error) {
	// Tag doesn't exist
}

if (tagExists && !skipChecks) {
	console.error(`❌ Git tag ${gitTag} already exists. Bump the version first or use --skip-checks.`);
	process.exit(1);
}

// Create git tag (delete first if it exists and we're skipping checks)
if (tagExists) {
	console.log(`\n🗑️  Deleting existing tag ${gitTag}...`);
	run(`git tag -d ${gitTag}`);
	try {
		execSync(`git push origin :refs/tags/${gitTag}`, { stdio: 'pipe' });
		console.log(`   Deleted remote tag`);
	} catch (error) {
		// Remote tag might not exist, that's fine
	}
}

// Clean and build before publishing
console.log('\n🔨 Building...');
run('yarn build');

console.log('\n📝 Creating git tag...');
run(`git tag ${gitTag}`);

console.log('\n🚀 Pushing git tag...');
run(`git push origin ${gitTag}`);

// Publish to npm
console.log('\n📦 Publishing to npm...');
run(`npm publish --access public --tag ${distTag} --registry https://registry.npmjs.org`);

console.log(`\n✅ Successfully published ${version} to npm`);
console.log(`   Git tag: ${gitTag}`);
console.log(`   npm dist-tag: ${distTag}`);
