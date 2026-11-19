import { readFile, writeFile } from 'node:fs/promises';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const [input, output, iconPath, digest] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const executable = NtExecutable.from(await readFile(input), { ignoreCert: true });
const resources = NtExecutableResource.from(executable);
const pictures = Data.IconFile.from(await readFile(iconPath)).icons.map(icon => icon.data);
const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
if (!groups.length) throw new Error('The runtime has no icon groups');
for (const group of groups) {
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, pictures);
}

const versions = Resource.VersionInfo.fromEntries(resources.entries);
if (!versions.length) throw new Error('The runtime has no version resource');
for (const info of versions) {
  info.setFileVersion(manifest.version);
  info.setProductVersion(manifest.version);
  for (const translation of info.getAllLanguagesForStringValues()) {
    info.setStringValues(translation, {
      FileDescription: `${manifest.productName} · 北航羽毛球提醒`,
      ProductName: manifest.productName,
      InternalName: 'Houyu',
      OriginalFilename: 'Houyu.exe',
      CompanyName: '',
    });
  }
  info.outputToResourceEntries(resources.entries);
}

if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid ASAR integrity header');
const integrity = new TextEncoder().encode(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: digest }]));
const { lang, codepage } = versions[0].getAllLanguagesForStringValues()[0];
resources.replaceResourceEntry({ type: 'INTEGRITY', id: 'ELECTRONASAR', lang, codepage, bin: integrity.buffer });
resources.outputResource(executable);
await writeFile(output, Buffer.from(executable.generate()), { flag: 'wx' });
