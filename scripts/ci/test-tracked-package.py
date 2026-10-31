#!/usr/bin/env python3
"""Small owned Git/ZIP fixture: prove archive input excludes runner checkout dirt."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VALIDATE = ROOT / 'scripts/ci/validate.sh'


def git(root, *args):
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(root), *args],
                          check=True, capture_output=True, text=True)


def commit_fixture(root):
    git(root, 'add', '.')
    git(root, '-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Owned source fixture')


class TrackedPackage(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='tab-package-unit-',
            dir=os.environ.get('CI_TEST_TMP_ROOT') or os.environ.get('RUNNER_TEMP'))
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name) / 'repo'
        self.root.mkdir()
        self.runner_temp = Path(self.scratch.name) / 'runner-temp'
        self.runner_temp.mkdir()
        git(self.root, 'init', '-q')
        files = {'manifest.json':json.dumps({'manifest_version':3,'name':'fixture','version':'1.4.0'}),
                 'background.js':'committed-background', 'popup.js':'committed-popup',
                 'popup.html':'<html>committed</html>', 'LICENSE':'fixture',
                 '.gitignore':'.env\n.env.*\ndist/\n',
                 'scripts/package.sh':(ROOT / 'scripts/package.sh').read_text()}
        for language in ('en', 'ru', 'uz'):
            files[f'_locales/{language}/messages.json'] = '{}'
        for prefix in ('icon', 'icon-on-icon', 'icon-off-icon'):
            for size in (16, 48, 128):
                files[f'assets/icons/{prefix}{size}.png'] = 'small fixture'
        for path, content in files.items():
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        commit_fixture(self.root)

    def package(self):
        env = dict(os.environ, RUNNER_TEMP=str(self.runner_temp))
        return subprocess.run(['bash', '-c', 'source "$1"; package_tracked',
                               'tracked-package-test', str(VALIDATE)],
                              cwd=self.root, env=env, capture_output=True, text=True, timeout=15)

    def test_untracked_ignored_and_modified_files_are_excluded(self):
        (self.root / 'assets/untracked-payload.js').write_text('not committed')
        (self.root / '_locales/en/untracked.json').write_text('not committed')
        (self.root / 'assets/.env').write_text('synthetic ignored payload, no credentials')
        (self.root / 'background.js').write_text('modified working tree')
        (self.root / 'scripts/package.sh').write_text('exit 99\n')
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.root / 'dist/tab-rotator-1.4.0.zip') as archive:
            self.assertEqual(archive.read('background.js'), b'committed-background')
            self.assertFalse({'assets/untracked-payload.js', '_locales/en/untracked.json',
                              'assets/.env', 'scripts/package.sh'} & set(archive.namelist()))
        self.assertFalse(list(self.runner_temp.iterdir()), 'owned snapshot must be cleaned')

    def test_committed_symlinks_fail_closed(self):
        (self.root / 'assets/link').symlink_to('../background.js')
        commit_fixture(self.root)
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'dist').exists())
        self.assertFalse(list(self.runner_temp.iterdir()))

    def test_existing_output_is_preserved(self):
        (self.root / 'dist').mkdir()
        output = self.root / 'dist/tab-rotator-1.4.0.zip'
        output.write_bytes(b'preserve prior output')
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_bytes(), b'preserve prior output')
        self.assertFalse(list(self.runner_temp.iterdir()))


if __name__ == '__main__':
    unittest.main()
