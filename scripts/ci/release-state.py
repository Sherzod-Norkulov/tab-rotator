#!/usr/bin/python3
"""Preserve existing releases; an unpublished existing tag must match this source."""
import json
import importlib.util
import os
from pathlib import Path
import re
import urllib.request
import urllib.error
REPO='Sherzod-Norkulov/tab-rotator'
_spec=importlib.util.spec_from_file_location('artifact_context',Path(__file__).with_name('artifact.py'))
_artifact=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_artifact)
trusted_context=_artifact.context
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ValueError('GitHub redirect refused')
def get(path):
    request=urllib.request.Request('https://api.github.com/repos/'+REPO+'/'+path, headers={
        'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(request,timeout=20) as response:
            return json.loads(response.read(1024*1024))
    except urllib.error.HTTPError as ex:
        if ex.code==404:return None
        raise RuntimeError('GitHub API failed with status '+str(ex.code)) from None
def main():
    trusted_context()
    if os.environ.get('GITHUB_JOB') != 'release':raise ValueError('Release state requires the receiver job')
    version=json.loads(Path('manifest.json').read_text())['version']
    if os.environ.get('EXPECTED_VERSION')!=version or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}',version):raise ValueError('Producer version mismatch')
    tag='v'+version;release=get('releases/tags/'+tag);ref=get('git/ref/tags/'+tag)
    if release and (release.get('draft') is not False or release.get('prerelease') is not False or ref is None):raise ValueError('Published release state is inconsistent')
    if ref:
        obj=ref['object']
        for _ in range(4):
            if obj['type']=='commit':break
            if obj['type']!='tag':raise ValueError('Tag does not identify a commit')
            obj=get('git/tags/'+obj['sha'])['object']
        else:raise ValueError('Tag nesting exceeds the bound')
        if not release and obj['sha']!=os.environ.get('GITHUB_SHA'):raise ValueError('Existing unpublished tag points to another commit')
    with open(os.environ['GITHUB_OUTPUT'],'a') as f:
        f.write(f'tag={tag}\nrelease_exists={str(bool(release)).lower()}\ntag_exists={str(bool(ref)).lower()}\n')
if __name__=='__main__':main()
