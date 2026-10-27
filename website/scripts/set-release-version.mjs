import fs from 'node:fs/promises';
import path from 'node:path';

const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version ?? '')) {
  throw new Error('Usage: npm run release:set-version -- <semver>');
}
const file = path.resolve('src/data/release.json');
const current = JSON.parse(await fs.readFile(file, 'utf8'));
await fs.writeFile(file, JSON.stringify({ ...current, version }, null, 2) + '\n');
process.stdout.write(`Site release copy set to Equinox Local ${version}. Run npm run check to build and verify.\n`);
