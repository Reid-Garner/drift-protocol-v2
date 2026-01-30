#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================================
// FORK CONFIGURATION - Edit these for your fork
// ============================================================================
const FORK_PACKAGE_NAME = '@reidg/drift-sdk';
const FORK_TAG_PREFIX = 'reidg-'; // Optional: prefix for git tags to avoid conflicts

// ============================================================================

const skipChecks = process.argv.includes('--skip-checks');
const bumpMode = process.argv.includes('--bump');
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const versionFilePath = path.join(__dirname, '..', 'VERSION');

// Get version - either from --bump or command line
let version;

if (bumpMode) {
	// Fetch current official drift-labs/sdk version from npm
	let driftVersion;
	try {
		driftVersion = execSync('npm view @drift-labs/sdk version', { encoding: 'utf8' }).trim();
		console.log(`📡 Official @drift-labs/sdk version: ${driftVersion}`);
	} catch (error) {
		console.error('❌ Failed to fetch @drift-labs/sdk version from npm');
		process.exit(1);
	}

	// Parse drift version - e.g., "2.157.0" or "2.157.0-beta.1"
	const driftMatch = driftVersion.match(/^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)\.(\d+))?$/);
	if (!driftMatch) {
		console.error(`❌ Cannot parse drift version: ${driftVersion}`);
		process.exit(1);
	}
	const [, driftBase, driftPrerelease, driftNumStr] = driftMatch;
	const driftNum = driftNumStr ? parseInt(driftNumStr, 10) : 0;
	const prerelease = driftPrerelease || 'beta';

	// Read current version from VERSION file
	const currentVersion = fs.readFileSync(versionFilePath, 'utf8').trim();
	const currentMatch = currentVersion.match(/^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)\.(\d+))?$/);
	
	if (!currentMatch) {
		console.error(`❌ Cannot parse current version: ${currentVersion}`);
		process.exit(1);
	}

	const [, currentBase, , currentNumStr] = currentMatch;
	const currentNum = currentNumStr ? parseInt(currentNumStr, 10) : 0;

	let newNum;
	if (currentBase === driftBase) {
		// Same base - take the max and add 1
		newNum = Math.max(driftNum, currentNum) + 1;
	} else {
		// Different base - use drift's base and be 1 ahead of drift
		newNum = driftNum + 1;
	}

	version = `${driftBase}-${prerelease}.${newNum}`;
	
	console.log(`📦 Bumping: ${currentVersion} → ${version}`);
	
	// Update VERSION file
	fs.writeFileSync(versionFilePath, version + '\n');
} else {
	// Get version from command line
	const versionArg = process.argv.find(arg => arg.match(/^\d+\.\d+\.\d+/));
	if (!versionArg) {
		console.error('❌ Usage: node scripts/publish.js <version> [--skip-checks]');
		console.error('         node scripts/publish.js --bump [--skip-checks]');
		console.error('   Example: node scripts/publish.js 2.155.0-beta.10');
		console.error('   Example: node scripts/publish.js --bump');
		process.exit(1);
	}
	version = versionArg;
}

const gitTag = `${FORK_TAG_PREFIX}v${version}`;

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
console.log(`📛 Package name: ${FORK_PACKAGE_NAME}`);
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

// Read and backup original package.json
const originalPackageJson = fs.readFileSync(packageJsonPath, 'utf8');
const packageJson = JSON.parse(originalPackageJson);

// Function to restore original package.json
function restorePackageJson() {
	console.log('\n🔄 Restoring original package.json...');
	fs.writeFileSync(packageJsonPath, originalPackageJson);
}

// Ensure we restore on exit
process.on('exit', restorePackageJson);
process.on('SIGINT', () => { restorePackageJson(); process.exit(1); });
process.on('SIGTERM', () => { restorePackageJson(); process.exit(1); });
process.on('uncaughtException', (err) => { restorePackageJson(); throw err; });

// Check if tag already exists
let tagExists = false;
try {
	execSync(`git rev-parse ${gitTag}`, { stdio: 'pipe' });
	tagExists = true;
} catch (error) {
	// Tag doesn't exist
}

if (tagExists && !skipChecks) {
	console.error(`❌ Git tag ${gitTag} already exists. Use a different version or use --skip-checks.`);
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

// Temporarily modify package.json with fork name and version
console.log('\n📝 Temporarily updating package.json for publish...');
packageJson.name = FORK_PACKAGE_NAME;
packageJson.version = version;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, '\t') + '\n');

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

// Restore will happen automatically via process.on('exit')

console.log(`\n✅ Successfully published ${FORK_PACKAGE_NAME}@${version} to npm`);
console.log(`   Git tag: ${gitTag}`);
console.log(`   npm dist-tag: ${distTag}`);
