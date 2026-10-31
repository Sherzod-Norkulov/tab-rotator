#!/usr/bin/python3
"""Fixed-path, write-once handoff of the exact ZIP produced by this Actions attempt."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import zipfile
import io
BASE = Path('/var/lib/github-actions-artifacts/1114674208')
REPO = 'Sherzod-Norkulov/tab-rotator'

def validate_context(env, event, head, remote, root):
    expected = {'GITHUB_ACTIONS':'true', 'GITHUB_REPOSITORY': REPO,
                'GITHUB_REPOSITORY_ID':'1114674208', 'GITHUB_REF':'refs/heads/main',
                'GITHUB_ACTOR':'Sherzod-Norkulov', 'GITHUB_TRIGGERING_ACTOR':'Sherzod-Norkulov',
                'GITHUB_WORKFLOW_REF':REPO+'/.github/workflows/release.yml@refs/heads/main'}
    if any(env.get(key) != value for key,value in expected.items()):
        raise ValueError('Untrusted source context')
    if env.get('GITHUB_EVENT_NAME') not in ('push','workflow_dispatch'):
        raise ValueError('Only owner main push/manual source is accepted')
    sha = env.get('GITHUB_SHA','')
    if (not re.fullmatch('[0-9a-f]{40}',sha) or env.get('GITHUB_WORKFLOW_SHA') != sha
            or head != sha or remote != sha):
        raise ValueError('Exact caller/source revision mismatch')
    run, attempt = env.get('GITHUB_RUN_ID',''), env.get('GITHUB_RUN_ATTEMPT','')
    job = env.get('GITHUB_JOB','')
    if any(not re.fullmatch('[1-9][0-9]*',value) for value in (run,attempt)) or job not in ('build','release'):
        raise ValueError('Invalid producer or receiver identity')
    if root != Path(env.get('GITHUB_WORKSPACE','')).resolve() / ('ci-'+run+'-'+attempt+'-'+job):
        raise ValueError('Unexpected source checkout')
    if not isinstance(event,dict) or not isinstance(event.get('repository'),dict):
        raise ValueError('Missing source event repository')
    repository = event['repository']
    if (repository.get('id') != 1114674208 or type(repository.get('id')) is not int
            or repository.get('full_name') != REPO or repository.get('private') is not False
            or repository.get('default_branch') != 'main'
            or not isinstance(repository.get('owner'),dict)
            or repository['owner'].get('login') != 'Sherzod-Norkulov'
            or event.get('deleted') or event.get('forced')):
        raise ValueError('Public owner repository identity mismatch')
    if env['GITHUB_EVENT_NAME'] == 'push' and (event.get('after') != sha or event.get('ref') != env['GITHUB_REF']):
        raise ValueError('Push payload source mismatch')
    return {'source_sha':sha,'run_id':run,'attempt':attempt,'repository':REPO,
            'repository_id':'1114674208','workflow_ref':env['GITHUB_WORKFLOW_REF'],
            'workflow_sha':sha,'producer_job':'build'}


def context():
    if os.getuid() != 973:
        raise ValueError('Expected provisioned unprivileged runner')
    payload = Path(os.environ['GITHUB_EVENT_PATH'])
    if not payload.is_file() or payload.stat().st_size > 1024*1024:
        raise ValueError('Invalid source event payload')
    def git(*args):
        return subprocess.check_output(['git',*args],text=True).strip()
    return validate_context(os.environ,json.loads(payload.read_text()),git('rev-parse','HEAD'),
                            git('rev-parse','refs/remotes/origin/main'),
                            Path(git('rev-parse','--show-toplevel')).resolve())

def package(version, content):
    if len(content) > 8 * 1024 * 1024 or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}', version):
        raise ValueError('Invalid package size or version')
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        members = archive.infolist()
        if (len(members) > 1024 or sum(item.file_size for item in members) > 64*1024*1024
                or any(item.file_size < 0 for item in members)
                or archive.getinfo('manifest.json').file_size > 256*1024):
            raise ValueError('ZIP expansion exceeds the memory bound')
        if archive.testzip() is not None or json.loads(archive.read('manifest.json'))['version'] != version:
            raise ValueError('Invalid ZIP or embedded manifest')
        for name in archive.namelist():
            if name.startswith('/') or '\\' in name or ':' in name or '..' in Path(name).parts or name.startswith(('.git', 'scripts/')):
                raise ValueError('Unexpected ZIP member')
    return hashlib.sha256(content).hexdigest()

def regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > limit:
            raise ValueError('Invalid handoff file')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            return f.read(limit + 1)
    finally:
        os.close(fd)

def main(mode):
    c = context()
    expected_job = 'release' if mode == 'restore' else 'build'
    if os.environ.get('GITHUB_JOB') != expected_job:
        raise ValueError('Handoff operation has the wrong producer/receiver job')
    if mode == 'context':
        return
    info = BASE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 973 or info.st_mode & 0o077:
        raise ValueError('Private provisioned artifact root is required')
    version = json.loads(Path('manifest.json').read_text())['version']
    name = 'tab-rotator-' + version + '.zip'
    path = BASE
    for part in (c['source_sha'], c['run_id'], c['attempt'], 'build'):
        path = path / part
        if mode == 'store':
            path.mkdir(mode=0o700, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 973 or info.st_mode & 0o077:
            raise ValueError('Invalid artifact directory')
    if mode == 'store':
        content = regular(Path('dist') / name, 8 * 1024 * 1024)
        digest = package(version, content)
        receipt = dict(c, version=version, file=name, sha256=digest)
        for file, data in ((name, content), ('manifest.json', (json.dumps(receipt, sort_keys=True) + '\n').encode())):
            with (path / file).open('xb') as f:
                f.write(data)
            (path / file).chmod(0o600)
        with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
            f.write(f'version={version}\nartifact-name=tab-rotator-{version}\nzip-sha256={digest}\n')
        print('ZIP_SHA256=' + digest)
    elif mode == 'restore':
        expected = os.environ.get('EXPECTED_ZIP_SHA256', '')
        if os.environ.get('EXPECTED_VERSION') != version or not re.fullmatch('[0-9a-f]{64}', expected):
            raise ValueError('Producer outputs are invalid')
        receipt = json.loads(regular(path / 'manifest.json', 16384))
        content = regular(path / name, 8 * 1024 * 1024)
        if receipt != dict(c, version=version, file=name, sha256=expected) or hashlib.sha256(content).hexdigest() != expected or package(version, content) != expected:
            raise ValueError('Producer identity or ZIP checksum mismatch')
        Path('dist').mkdir(mode=0o700, exist_ok=True)
        with (Path('dist') / name).open('xb') as f:
            f.write(content)
    else:
        raise ValueError('Unsupported handoff operation')

if __name__ == '__main__':
    main(sys.argv[1])
