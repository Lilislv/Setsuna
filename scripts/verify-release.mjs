import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const release = json('src/release-info.json');
assert.match(release.displayVersion, /^\d+\.\d+\.\d+$/);
for (const path of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) assert.equal(json(path).version, release.displayVersion, path);
assert.equal(json('package-lock.json').packages[''].version, release.displayVersion);
for (const path of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) assert.equal(/name = "Setsuna"\r?\nversion = "([^"]+)"/.exec(readFileSync(path, 'utf8'))?.[1], release.displayVersion, path);
console.log(`Release version verified: ${release.displayVersion}`);
