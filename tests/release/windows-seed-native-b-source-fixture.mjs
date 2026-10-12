// Hosted Windows x64/ARM64 installer acceptance ONLY. Prepare the disposable
// committed Git B checkout using the same product dependency contract as the
// managed-source updater. This script cannot select an update or touch WPF.
import { seedPrebuiltDependenciesFromStableRelease } from '../../src/equinox-local-managed-source-enrollment.js';

const [sourceB, sourceA] = process.argv.slice(2);
if (!sourceB || !sourceA || process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') {
  throw new Error('Disposable Windows native B dependency fixture is hosted-only.');
}
await seedPrebuiltDependenciesFromStableRelease(sourceB, sourceA);
