#!/usr/bin/python3
import importlib.util
from pathlib import Path
import io,json,os,zipfile,unittest,tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('artifact',Path(__file__).with_name('artifact.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class HandoffTests(unittest.TestCase):
 def test_embedded_version_and_zip_integrity(self):
  b=io.BytesIO()
  with zipfile.ZipFile(b,'w') as z:z.writestr('manifest.json',json.dumps({'version':'1.4.0'}))
  self.assertEqual(len(a.package('1.4.0',b.getvalue())),64)
  with self.assertRaises(ValueError):a.package('1.5.0',b.getvalue())
 def test_traversal_not_packaged(self):
  b=io.BytesIO()
  with zipfile.ZipFile(b,'w') as z:
   z.writestr('manifest.json',json.dumps({'version':'1.4.0'}));z.writestr('../outside','x')
  with self.assertRaises(ValueError):a.package('1.4.0',b.getvalue())
 def test_symlink_handoff_refused(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'file').write_bytes(b'content');(root/'link').symlink_to(root/'file')
   with self.assertRaises(OSError):a.regular(root/'link',100)
 def test_pr_or_other_actor_or_stale_workflow_refused(self):
  base={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':a.REPO,'GITHUB_REPOSITORY_ID':'1114674208','GITHUB_REF':'refs/heads/main','GITHUB_ACTOR':'Sherzod-Norkulov','GITHUB_TRIGGERING_ACTOR':'Sherzod-Norkulov','GITHUB_EVENT_NAME':'push','GITHUB_SHA':'a'*40,'GITHUB_WORKFLOW_SHA':'a'*40,'GITHUB_WORKFLOW_REF':a.REPO+'/.github/workflows/release.yml@refs/heads/main','GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_JOB':'build','GITHUB_WORKSPACE':'/tmp/tab-owned'}
  event={'repository':{'id':1114674208,'full_name':a.REPO,'owner':{'login':'Sherzod-Norkulov'},'private':False,'default_branch':'main'},'after':'a'*40,'ref':'refs/heads/main'}
  root=Path('/tmp/tab-owned/ci-1-1-build')
  self.assertEqual(a.validate_context(base,event,'a'*40,'a'*40,root)['run_id'],'1')
  for change in [{'GITHUB_EVENT_NAME':'pull_request'},{'GITHUB_ACTOR':'other'},{'GITHUB_REF':'refs/pull/1/merge'},{'GITHUB_WORKFLOW_SHA':'b'*40},{'GITHUB_WORKFLOW_REF':a.REPO+'/.github/workflows/other.yml@refs/heads/main'},{'GITHUB_JOB':'unexpected'}]:
   with self.subTest(change=change),self.assertRaises(ValueError):a.validate_context(dict(base,**change),event,'a'*40,'a'*40,root)
  for invalid in [dict(event,forced=True),dict(event,after='b'*40),dict(event,repository=dict(event['repository'],private=True))]:
   with self.assertRaises(ValueError):a.validate_context(base,invalid,'a'*40,'a'*40,root)
  with self.assertRaises(ValueError):a.validate_context(base,event,'a'*40,'b'*40,root)
  with self.assertRaises(ValueError):a.validate_context(base,event,'a'*40,'a'*40,root.parent)
 def test_manifest_expansion_is_bounded(self):
  b=io.BytesIO()
  with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:
   z.writestr('manifest.json',json.dumps({'version':'1.4.0','padding':'x'*(256*1024)}))
  with self.assertRaisesRegex(ValueError,'memory bound'):a.package('1.4.0',b.getvalue())
 def test_windows_traversal_not_packaged(self):
  b=io.BytesIO()
  with zipfile.ZipFile(b,'w') as z:
   z.writestr('manifest.json',json.dumps({'version':'1.4.0'}));z.writestr('..\\outside','x')
  with self.assertRaises(ValueError):a.package('1.4.0',b.getvalue())
if __name__=='__main__':unittest.main()
