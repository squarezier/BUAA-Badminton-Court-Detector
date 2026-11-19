"""Regression checks for packaging source boundaries and interrupted builds."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main, mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import package
from icon import icon


class PackagingTest(TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.docs = self.root / 'docs'
        self.docs.mkdir()
        self.out = self.root / 'dist'
        self.out.mkdir()

    def test_offline_guide_and_nested_image(self):
        text = b'# Help\n![Court](pictures/court.png)\n'
        (self.docs / 'guide.md').write_bytes(text)
        (self.docs / 'pictures').mkdir()
        (self.docs / 'pictures/court.png').write_bytes(b'image fixture')
        with mock.patch.object(package, 'ROOT', self.root):
            package.copy_guide(self.out)
        self.assertEqual((self.out / '使用说明.md').read_bytes(), text)
        self.assertEqual((self.out / 'pictures/court.png').read_bytes(), b'image fixture')

    def test_guide_and_asset_links_fail_closed(self):
        guide = self.docs / 'guide.md'
        actual = self.root / 'unlisted'
        actual.write_text('unlisted fixture')
        guide.symlink_to(actual)
        with mock.patch.object(package, 'ROOT', self.root):
            with self.assertRaises(ValueError):
                package.copy_guide(self.out)
            self.assertFalse((self.out / '使用说明.md').exists())
            guide.unlink()
            guide.write_text('![Court](pictures/court.png)')
            (self.root / 'pictures').mkdir()
            (self.root / 'pictures/court.png').write_bytes(b'unlisted picture fixture')
            (self.docs / 'pictures').symlink_to(self.root / 'pictures', target_is_directory=True)
            with self.assertRaises(ValueError):
                package.copy_guide(self.out)
            self.assertFalse((self.out / 'pictures/court.png').exists())

    def test_interruption_preserves_previous_archive_and_retry_replaces_it(self):
        for name in ('electron', '@electron/fuses', '@electron/asar', 'resedit'):
            manifest = self.root / 'node_modules' / name / 'package.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{}')
        live = self.out / 'Houyu.zip'
        live.write_bytes(b'previous complete release')
        def interrupted(runtime, stage, dest):
            dest.write_bytes(b'incomplete')
            raise OSError('fixture: interrupted write')
        argv = ['package.py', 'win32-x64', str(self.root), str(self.root / 'stage'), str(live)]
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(package, 'ROOT', self.root), mock.patch.object(package, 'verified_runtime'):
            with mock.patch.object(package, 'windows_package', side_effect=interrupted):
                with self.assertRaises(OSError):
                    package.main()
            self.assertEqual(live.read_bytes(), b'previous complete release')
            self.assertEqual(list(self.out.iterdir()), [live])
            with mock.patch.object(package, 'windows_package', side_effect=lambda r, s, p: p.write_bytes(b'complete')):
                package.main()
            self.assertEqual(live.read_bytes(), b'complete')
            alias = self.out / 'alias.zip'
            alias.symlink_to(live)
            argv[-1] = str(alias)
            with self.assertRaises(ValueError):
                package.main()
            self.assertEqual(live.read_bytes(), b'complete')

    def test_icon_cast_shadow_has_transparent_margin_at_native_sizes(self):
        for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
            with self.subTest(size=size):
                px = 512 / size
                self.assertEqual(icon(0, 0, px)[3], 0)
                self.assertEqual(icon(256, 512, px)[3], 0)
                self.assertEqual(icon(256, 256, px)[3], 255)
                self.assertLess(icon(256, 20, px)[3], icon(256, 478, px)[3])
                self.assertLess(icon(256, 478, px)[3], 128)


if __name__ == '__main__':
    main()
