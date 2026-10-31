#!/usr/bin/python3
"""Owner-only same-repository PR validation; grants no release/handoff authority."""
import json
import os
from pathlib import Path
import re
import subprocess

OWNER = 'Sherzod-Norkulov'
REPO = OWNER + '/tab-rotator'
REPOSITORY_ID = 1114674208


def repository(value):
    return (isinstance(value, dict) and type(value.get('id')) is int
            and value['id'] == REPOSITORY_ID and value.get('full_name') == REPO
            and value.get('private') is False and value.get('fork') is False
            and (value.get('owner') or {}).get('login') == OWNER)


def validate(env, event, head, parents, root):
    if not isinstance(event, dict) or not repository(event.get('repository')):
        raise ValueError('PR repository identity is refused')
    pr = event.get('pull_request')
    if not isinstance(pr, dict):
        raise ValueError('Missing PR payload')
    number = event.get('number')
    if (type(number) is not int or number <= 0 or pr.get('number') != number
            or event.get('action') not in ('opened', 'synchronize', 'reopened', 'ready_for_review')
            or (event.get('sender') or {}).get('login') != OWNER
            or (pr.get('user') or {}).get('login') != OWNER
            or pr.get('state') != 'open' or pr.get('merged') is not False):
        raise ValueError('Only current owner PR events are accepted')
    base, source = pr.get('base') or {}, pr.get('head') or {}
    if (not repository(base.get('repo')) or not repository(source.get('repo'))
            or event['repository'].get('default_branch') != 'main'
            or base.get('ref') != 'main' or not isinstance(source.get('ref'), str)
            or not source['ref'] or source['ref'] == 'main'
            or any(not re.fullmatch('[0-9a-f]{40}', x.get('sha', '')) for x in (base, source))):
        raise ValueError('Fork or unexpected base/head is refused')
    sha = env.get('GITHUB_SHA', '')
    expected = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'pull_request',
                'GITHUB_REPOSITORY': REPO, 'GITHUB_REPOSITORY_ID': str(REPOSITORY_ID),
                'GITHUB_ACTOR': OWNER, 'GITHUB_TRIGGERING_ACTOR': OWNER,
                'GITHUB_BASE_REF': 'main', 'GITHUB_HEAD_REF': source['ref'],
                'GITHUB_REF': f'refs/pull/{number}/merge',
                'GITHUB_WORKFLOW_REF': f'{REPO}/.github/workflows/pr.yml@refs/pull/{number}/merge',
                'GITHUB_WORKFLOW_SHA': sha, 'GITHUB_JOB': 'build'}
    if (any(env.get(key) != value for key, value in expected.items())
            or not re.fullmatch('[0-9a-f]{40}', sha) or head != sha
            or parents != [base['sha'], source['sha']]
            or (pr.get('merge_commit_sha') is not None and pr['merge_commit_sha'] != sha)):
        raise ValueError('Exact PR merge/base/head identity mismatch')
    run, attempt = env.get('GITHUB_RUN_ID', ''), env.get('GITHUB_RUN_ATTEMPT', '')
    if (any(not re.fullmatch('[1-9][0-9]*', v) for v in (run, attempt))
            or root != Path(env.get('GITHUB_WORKSPACE', '')).resolve() / f'ci-{run}-{attempt}-build'):
        raise ValueError('Unexpected PR checkout or attempt')
    return {'merge_sha': sha, 'base_sha': base['sha'], 'head_sha': source['sha'],
            'pull_request': number, 'run_id': run, 'attempt': attempt,
            'release_authority': False}


def main():
    if os.getuid() != 973:
        raise ValueError('Expected provisioned unprivileged PR runner')
    payload = Path(os.environ['GITHUB_EVENT_PATH'])
    if not payload.is_file() or payload.stat().st_size > 1024 * 1024:
        raise ValueError('Invalid PR event size')
    def git(*args):
        return subprocess.check_output(['git', *args], text=True).strip()
    result = validate(os.environ, json.loads(payload.read_text()), git('rev-parse', 'HEAD'),
                      git('show', '-s', '--format=%P', 'HEAD').split(),
                      Path(git('rev-parse', '--show-toplevel')).resolve())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
