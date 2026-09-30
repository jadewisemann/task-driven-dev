// Release guard: the tag, package.json and the mobile app's app.json must agree.
//   node .github/scripts/check-versions.mjs v0.1.0-alpha.1
// app.json keeps a numeric version (iOS needs it) and the prerelease part in extra.channel,
// so 0.1.0-alpha.1 <=> app.json version "0.1.0" + extra.channel "alpha.1".
// Store build numbers (android.versionCode / ios.buildNumber) must be bumped by hand for each release.
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const tag = process.argv[2] || '';
const pkg = read('package.json').version;
const app = read('apps/mobile/app.json').expo;
const [base, channel = null] = pkg.split(/-(.*)/s);

const problems = [];
if (tag !== `v${pkg}`) problems.push(`tag ${tag} does not match package.json version ${pkg}`);
if (app.version !== base) problems.push(`apps/mobile/app.json version ${app.version} should be ${base}`);
if ((app.extra?.channel ?? null) !== channel) problems.push(`apps/mobile/app.json extra.channel ${app.extra?.channel ?? '(none)'} should be ${channel ?? '(none)'}`);
if (!Number.isInteger(app.android?.versionCode)) problems.push('apps/mobile/app.json android.versionCode is missing');
if (!/^\d+$/.test(app.ios?.buildNumber ?? '')) problems.push('apps/mobile/app.json ios.buildNumber is missing');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`versions agree: ${pkg} (app ${app.version} · ${channel ?? 'stable'}, versionCode ${app.android.versionCode}, build ${app.ios.buildNumber})`);
