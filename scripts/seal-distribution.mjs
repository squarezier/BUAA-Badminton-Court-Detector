import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPackage, getRawHeader } from '@electron/asar';
import { flipFuses, getCurrentFuseWire, FuseState, FuseVersion, FuseV1Options as F } from '@electron/fuses';

const [mode, input, output] = process.argv.slice(2);
if (mode === 'archive') {
  await createPackage(input, output);
  process.stdout.write(createHash('sha256').update(getRawHeader(output).headerString).digest('hex'));
} else if (mode === 'fuses') {
  const settings = {
    [F.RunAsNode]: false,
    [F.EnableCookieEncryption]: true,
    [F.EnableNodeOptionsEnvironmentVariable]: false,
    [F.EnableNodeCliInspectArguments]: false,
    [F.EnableEmbeddedAsarIntegrityValidation]: output !== 'linux',
    [F.OnlyLoadAppFromAsar]: true,
    [F.GrantFileProtocolExtraPrivileges]: false,
  };
  await flipFuses(input, { version: FuseVersion.V1, ...settings });
  const actual = await getCurrentFuseWire(input);
  for (const [key, enabled] of Object.entries(settings)) {
    assert.equal(actual[key], enabled ? FuseState.ENABLE : FuseState.DISABLE, F[key]);
  }
} else {
  throw new Error('Expected archive or fuses');
}
