#!/usr/bin/env python3
"""Pure API-state models; never contact GitHub or create/modify tags/releases."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_state', Path(__file__).with_name('release-state.py'))
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class ReleaseState(unittest.TestCase):
    def run_state(self, release, tag_sha):
        with tempfile.TemporaryDirectory(prefix='tab-release-state-',
                dir=os.environ.get('CI_TEST_TMP_ROOT') or os.environ.get('RUNNER_TEMP')) as directory:
            output = Path(directory) / 'outputs'
            env = {'GITHUB_JOB':'release','GITHUB_SHA':'a'*40,'EXPECTED_VERSION':'1.4.0','GITHUB_OUTPUT':str(output)}
            responses = [release, {'object':{'type':'commit','sha':tag_sha}} if tag_sha else None]
            with patch.dict(os.environ, env, clear=True), patch.object(state,'trusted_context',return_value={}), \
                    patch.object(state,'get',side_effect=responses), \
                    patch.object(state.Path,'read_text',return_value='{"version":"1.4.0"}'):
                state.main()
            return output.read_text()

    def test_published_140_is_preserved_on_later_source(self):
        result = self.run_state({'draft':False,'prerelease':False}, 'b'*40)
        self.assertIn('release_exists=true',result)
        self.assertIn('tag_exists=true',result)
        self.assertIn('tag=v1.4.0',result)

    def test_unpublished_tag_must_match_exact_source(self):
        self.assertIn('release_exists=false',self.run_state(None,'a'*40))
        with self.assertRaisesRegex(ValueError,'another commit'):
            self.run_state(None,'b'*40)

    def test_inconsistent_published_state_fails_closed(self):
        for release,tag in [({'draft':True,'prerelease':False},'a'*40),
                            ({'draft':False,'prerelease':True},'a'*40),
                            ({'draft':False,'prerelease':False},None)]:
            with self.subTest(release=release), self.assertRaisesRegex(ValueError,'inconsistent'):
                self.run_state(release,tag)

    def test_absent_release_and_tag_allow_new_exact_source(self):
        result = self.run_state(None,None)
        self.assertIn('release_exists=false',result)
        self.assertIn('tag_exists=false',result)


if __name__ == '__main__':
    unittest.main()
