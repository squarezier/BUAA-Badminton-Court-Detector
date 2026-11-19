#!/usr/bin/env python3
"""Pack verified Electron release archives with Houyu branding."""

import argparse
import hashlib
import json
import plistlib
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from icon import windows_icon


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'package.json').read_text())
RELEASE = MANIFEST['devDependencies']['electron']
PRODUCT = MANIFEST['productName']
TARGETS = ('darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64')


def run(*args):
    subprocess.run(args, check=True)


def verified_runtime(location, target):
    name = f'electron-v{RELEASE}-{target}.zip'
    result = location / name
    # These official hashes are part of the exact Electron npm tarball authenticated by package-lock.json.
    checksums = json.loads((ROOT / 'node_modules/electron/checksums.json').read_text())
    expected = checksums[name]

    def check(file):
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != expected.lower():
            raise RuntimeError(f'Checksum mismatch for {name}')

    if result.is_file():
        check(result)
        return result
    location.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=location) as downloads:
        temporary = Path(downloads) / name
        url = f'https://github.com/electron/electron/releases/download/v{RELEASE}/{name}'
        run('curl', '--fail', '--silent', '--show-error', '--location', '--retry', '3',
            '--proto', '=https', '--proto-redir', '=https', '--output', temporary, url)
        check(temporary)
        temporary.replace(result)
    return result


def stage_app(resources, stage):
    with tempfile.TemporaryDirectory(dir=stage) as source:
        app = Path(source)
        shutil.copy(ROOT / 'package.json', app)
        shutil.copytree(ROOT / 'src', app / 'src')
        digest = subprocess.check_output(['node', ROOT / 'scripts/seal-distribution.mjs',
                                          'archive', app, resources / 'app.asar'], text=True)
    if len(digest) != 64 or any(ch not in '0123456789abcdef' for ch in digest):
        raise ValueError('Invalid ASAR integrity header')
    (resources / 'default_app.asar').unlink(missing_ok=True)
    return digest


def seal_runtime(executable, platform):
    run('node', ROOT / 'scripts/seal-distribution.mjs', 'fuses', executable, platform)


def copy_guide(folder):
    shutil.copy(ROOT / 'docs' / 'guide.md', folder / '使用说明.md')
    shutil.copy(ROOT / 'docs' / 'target.png', folder / 'target.png')


def mac_icon(stage, resources):
    source = ROOT / 'src' / 'ui' / 'icon.png'
    entries = []
    for kind, size in ((b'icp4', 16), (b'icp5', 32), (b'icp6', 64), (b'ic07', 128), (b'ic08', 256), (b'ic09', 512)):
        raster = stage / f'icon-{size}.png'
        subprocess.run(['sips', '-z', str(size), str(size), source, '--out', raster], check=True, stdout=subprocess.DEVNULL)
        data = raster.read_bytes()
        entries.append(kind + struct.pack('>I', len(data) + 8) + data)
    contents = b''.join(entries)
    (resources / 'Houyu.icns').write_bytes(b'icns' + struct.pack('>I', len(contents) + 8) + contents)


def mac_package(runtime, stage, output):
    run('ditto', '-x', '-k', runtime, stage)
    bundle = stage / f'{PRODUCT}.app'
    (stage / 'Electron.app').rename(bundle)
    contents = bundle / 'Contents'
    resources = contents / 'Resources'
    integrity = stage_app(resources, stage)
    mac_icon(stage, resources)
    plist_file = contents / 'Info.plist'
    with plist_file.open('rb') as file:
        config = plistlib.load(file)
    config.update(CFBundleName=PRODUCT, CFBundleDisplayName=PRODUCT, CFBundleIdentifier='local.courtwatch.buaa',
                  CFBundleIconFile='Houyu.icns', CFBundleShortVersionString=MANIFEST['version'], CFBundleVersion=MANIFEST['version'])
    config['ElectronAsarIntegrity'] = {'Resources/app.asar': {'algorithm': 'SHA256', 'hash': integrity}}
    with plist_file.open('wb') as file:
        plistlib.dump(config, file)
    seal_runtime(bundle, 'darwin')
    run('codesign', '--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags', bundle)
    run('codesign', '--verify', '--deep', '--strict', bundle)
    folder = stage / PRODUCT
    folder.mkdir()
    bundle.rename(folder / bundle.name)
    copy_guide(folder)
    run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', folder, output)


def windows_package(runtime, stage, output):
    folder = stage / 'Houyu'
    folder.mkdir()
    with ZipFile(runtime) as release:
        release.extractall(folder)
    icon = stage / 'Houyu.ico'
    windows_icon(icon)
    runtime_executable = folder / 'electron.exe'
    integrity = stage_app(folder / 'resources', stage)
    run('node', ROOT / 'scripts' / 'windows-brand.mjs', runtime_executable, folder / 'Houyu.exe', icon, integrity)
    runtime_executable.unlink()
    seal_runtime(folder / 'Houyu.exe', 'windows')
    copy_guide(folder)
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=4) as archive:
        for file in sorted(folder.rglob('*')):
            if file.is_file():
                archive.write(file, file.relative_to(stage))


def linux_package(runtime, stage, output):
    root = stage / 'package'
    app_dir = root / 'opt/houyu'
    app_dir.mkdir(parents=True)
    run('unzip', '-q', runtime, '-d', app_dir)
    (app_dir / 'electron').rename(app_dir / 'houyu')
    (app_dir / 'houyu').chmod(0o755)
    # The distribution owns the upstream Chromium sandbox helper as root.
    (app_dir / 'chrome-sandbox').chmod(0o4755)
    stage_app(app_dir / 'resources', stage)
    seal_runtime(app_dir / 'houyu', 'linux')

    binary = root / 'usr/bin/houyu'
    binary.parent.mkdir(parents=True)
    binary.symlink_to('/opt/houyu/houyu')
    desktop = root / 'usr/share/applications/houyu.desktop'
    desktop.parent.mkdir(parents=True)
    shutil.copy(ROOT / 'scripts/linux/houyu.desktop', desktop)
    icon = root / 'usr/share/icons/hicolor/512x512/apps/houyu.png'
    icon.parent.mkdir(parents=True)
    shutil.copy(ROOT / 'src/ui/icon.png', icon)
    guide = root / 'usr/share/doc/houyu'
    guide.mkdir(parents=True)
    copy_guide(guide)
    control = root / 'DEBIAN/control'
    control.parent.mkdir()
    template = (ROOT / 'scripts/linux/control.in').read_text()
    control.write_text(template.replace('@VERSION@', MANIFEST['version']))
    run('dpkg-deb', '--root-owner-group', '-Zxz', '-z4', '--build', root, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', choices=TARGETS)
    parser.add_argument('runtime', type=Path)
    parser.add_argument('staging', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if not all((ROOT / 'node_modules' / name / 'package.json').is_file() for name in ('electron', '@electron/fuses', '@electron/asar', 'resedit')):
        subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=ROOT, check=True)
    runtime = verified_runtime(args.runtime.resolve(), args.target)
    args.staging.resolve().mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    with tempfile.TemporaryDirectory(dir=args.staging.resolve()) as directory:
        stage = Path(directory)
        if args.target.startswith('darwin'):
            mac_package(runtime, stage, output)
        elif args.target == 'win32-x64':
            windows_package(runtime, stage, output)
        else:
            linux_package(runtime, stage, output)


if __name__ == '__main__':
    main()
