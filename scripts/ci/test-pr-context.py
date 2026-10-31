#!/usr/bin/python3
"""Bounded PR identity negatives and a strict release-handoff separation."""
import copy
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

pr = module('pr-context')
artifact = module('artifact')


class PullRequestContext(unittest.TestCase):
    def setUp(self):
        repo = {'id': pr.REPOSITORY_ID, 'full_name': pr.REPO, 'private': False,
                'fork': False, 'owner': {'login': pr.OWNER}, 'default_branch': 'main'}
        self.event = {'repository': repo, 'sender': {'login': pr.OWNER},
                      'action': 'synchronize', 'number': 7,
                      'pull_request': {'number': 7, 'user': {'login': pr.OWNER},
                                       'state': 'open', 'merged': False, 'merge_commit_sha': 'c' * 40,
                                       'base': {'repo': copy.deepcopy(repo), 'ref': 'main', 'sha': 'a' * 40},
                                       'head': {'repo': copy.deepcopy(repo), 'ref': 'ci/owner-change', 'sha': 'b' * 40}}}
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'pull_request',
                    'GITHUB_REPOSITORY': pr.REPO, 'GITHUB_REPOSITORY_ID': str(pr.REPOSITORY_ID),
                    'GITHUB_ACTOR': pr.OWNER, 'GITHUB_TRIGGERING_ACTOR': pr.OWNER,
                    'GITHUB_BASE_REF': 'main', 'GITHUB_HEAD_REF': 'ci/owner-change',
                    'GITHUB_REF': 'refs/pull/7/merge', 'GITHUB_SHA': 'c' * 40,
                    'GITHUB_WORKFLOW_SHA': 'c' * 40,
                    'GITHUB_WORKFLOW_REF': pr.REPO + '/.github/workflows/pr.yml@refs/pull/7/merge',
                    'GITHUB_JOB': 'build', 'GITHUB_RUN_ID': '8', 'GITHUB_RUN_ATTEMPT': '2',
                    'GITHUB_WORKSPACE': '/tmp/tab-unit'}
        self.root = Path('/tmp/tab-unit/ci-8-2-build')

    def validate(self, env=None, event=None, head=None, parents=None, root=None):
        return pr.validate(env or self.env, event or self.event, head or 'c' * 40,
                           parents if parents is not None else ['a' * 40, 'b' * 40], root or self.root)

    def test_exact_owner_merge_is_validation_only(self):
        self.assertFalse(self.validate()['release_authority'])

    def test_owner_and_caller_context_required(self):
        for key, value in [('GITHUB_ACTOR', 'outside'), ('GITHUB_TRIGGERING_ACTOR', 'outside'),
                           ('GITHUB_REF', 'refs/heads/main'), ('GITHUB_HEAD_REF', 'stale'),
                           ('GITHUB_BASE_REF', 'other'), ('GITHUB_EVENT_NAME', 'pull_request_target'),
                           ('GITHUB_WORKFLOW_SHA', 'd' * 40), ('GITHUB_JOB', 'release'),
                           ('GITHUB_WORKFLOW_REF', pr.REPO + '/.github/workflows/release.yml@refs/heads/main'),
                           ('GITHUB_RUN_ATTEMPT', '0')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(env=dict(self.env, **{key: value}))

    def test_fork_other_repo_author_or_payload_refused(self):
        for endpoint, key, value in [('head', 'id', 42), ('head', 'fork', True),
                                     ('head', 'private', True), ('head', 'full_name', 'outside/tab-rotator'),
                                     ('base', 'id', 42), ('base', 'fork', True)]:
            event = copy.deepcopy(self.event)
            event['pull_request'][endpoint]['repo'][key] = value
            with self.subTest(endpoint=endpoint, key=key), self.assertRaises(ValueError):
                self.validate(event=event)
        for mutate in [lambda e: e['pull_request']['user'].update(login='outside'),
                       lambda e: e['sender'].update(login='outside'),
                       lambda e: e['pull_request']['base'].update(ref='other'),
                       lambda e: e['pull_request'].update(state='closed'),
                       lambda e: e.update(action='closed'),
                       lambda e: e['pull_request'].update(merge_commit_sha='d' * 40)]:
            event = copy.deepcopy(self.event); mutate(event)
            with self.assertRaises(ValueError): self.validate(event=event)

    def test_merge_parents_checkout_and_sha_are_exact(self):
        for parents in [[], ['a' * 40], ['b' * 40, 'a' * 40], ['a' * 40, 'd' * 40]]:
            with self.subTest(parents=parents), self.assertRaises(ValueError): self.validate(parents=parents)
        with self.assertRaises(ValueError): self.validate(head='d' * 40)
        with self.assertRaises(ValueError): self.validate(root=self.root.parent)

    def test_release_handoff_always_rejects_pr(self):
        with self.assertRaises(ValueError):
            artifact.validate_context(self.env, self.event, 'c' * 40, 'a' * 40, self.root)

    def test_workflow_required_name_and_no_publishing_permission(self):
        root = HERE.parents[1]
        caller = (root / '.github/workflows/pr.yml').read_text()
        build = (root / '.github/workflows/ci.yml').read_text()
        self.assertIn('name: CI (обязательные проверки)', caller)
        self.assertIn('name: Валидация и сборка ZIP', build)
        self.assertIn('uses: ./.github/workflows/ci.yml', caller)
        for forbidden in ('contents: write', 'id-token: write', 'GH_TOKEN:', 'pull_request_target:', 'release.yml'):
            self.assertNotIn(forbidden, caller)


if __name__ == '__main__':
    unittest.main()
