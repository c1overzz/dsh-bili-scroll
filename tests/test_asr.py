"""Offline ASR control-flow tests; no network, Whisper model, or account needed."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import json


SOURCE = Path(__file__).resolve().parents[1] / 'lib' / 'asr.py'
WHISPER = '''import os,time
from pathlib import Path
from types import SimpleNamespace
class WhisperModel:
 def __init__(self,*args,**kwargs):
  if os.environ.get('ASR_STARTED'):Path(os.environ['ASR_STARTED']).touch()
 def transcribe(self,src,**kwargs):
  if os.environ.get('ASR_RELEASE'):
   end=time.monotonic()+15
   while not Path(os.environ['ASR_RELEASE']).exists():
    if time.monotonic()>end:raise RuntimeError('test gate timed out')
    time.sleep(.01)
  Path(src).read_bytes()
  if os.environ.get('ASR_RAISE'):raise RuntimeError('synthetic transcription failure')
  text=os.environ.get('ASR_TEXT','hello')*int(os.environ.get('ASR_REPEAT','1'))
  return [SimpleNamespace(text=text)],None
'''
YTDLP = '''import os,time,json
from pathlib import Path
class YoutubeDL:
 def __init__(self,opts):self.opts=opts
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def extract_info(self,*args,**kwargs):
  if os.environ.get('ASR_OPTIONS'):Path(os.environ['ASR_OPTIONS']).write_text(json.dumps(self.opts))
  p=Path(self.opts['outtmpl'].replace('%(ext)s','m4a'))
  if os.environ.get('ASR_CHECK_CLEAN'):assert not p.exists(),'stale audio reused'
  actual=p.with_suffix('.downloaded.m4a') if os.environ.get('ASR_ALT_PATH') else p
  actual.write_bytes(b'synthetic audio')
  if os.environ.get('ASR_DOWNLOAD_STARTED'):Path(os.environ['ASR_DOWNLOAD_STARTED']).touch()
  if os.environ.get('ASR_DOWNLOAD_RELEASE'):
   end=time.monotonic()+15
   while not Path(os.environ['ASR_DOWNLOAD_RELEASE']).exists():
    if time.monotonic()>end:raise RuntimeError('test gate timed out')
    time.sleep(.01)
  return {'path':str(p),'requested_downloads':[{'filepath':str(actual)}]}
 def prepare_filename(self,info):return info['path']
'''
SITECUSTOMIZE = '''import os,builtins
if os.environ.get('ASR_FAIL_REPLACE'):
 def fail_replace(*args,**kwargs):raise PermissionError('synthetic replace failure')
 os.replace=fail_replace
if os.environ.get('ASR_FAIL_LOCK'):
 original_open=builtins.open
 def guarded_open(file,*args,**kwargs):
  if str(file).endswith('.lock'):raise PermissionError('synthetic lock failure')
  return original_open(file,*args,**kwargs)
 builtins.open=guarded_open
'''


class AsrTests(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix='dsh-asr-test-')
        self.addCleanup(self.area.cleanup)
        self.root = Path(self.area.name)
        self.script = self.root / 'asr.py'
        shutil.copyfile(SOURCE, self.script)
        self.audio = self.root / 'audio.wav'
        self.audio.write_bytes(b'synthetic audio')
        for name, source in [('faster_whisper.py', WHISPER), ('yt_dlp.py', YTDLP),
                             ('sitecustomize.py', SITECUSTOMIZE)]:
            (self.root / name).write_text(source, encoding='utf-8')
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('ASR_')}
        self.env.update(PYTHONPATH=str(self.root), PYTHONIOENCODING='utf-8')

    def run_asr(self, *args, **env):
        return subprocess.run([sys.executable, str(self.script), *map(str, args)],
            cwd=self.root, env={**self.env, **env}, capture_output=True,
            text=True, encoding='utf-8', timeout=10)

    def start(self, target, **env):
        proc = subprocess.Popen([sys.executable, str(self.script), str(target)],
            cwd=self.root, env={**self.env, **env}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, proc)
        return proc

    @staticmethod
    def stop(proc):
        if proc.poll() is None:
            proc.kill()
        proc.communicate(timeout=10)

    def wait_started(self, marker, proc):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if marker.exists():
                return
            if proc.poll() is not None:
                break
            time.sleep(.01)
        if proc.poll() is not None:
            _, err = proc.communicate()
            self.fail('child exited before test gate: ' + err.decode('utf-8'))
        self.fail('child did not reach test gate')

    def test_local_stdout(self):
        result = self.run_asr(self.audio)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'hello\n')

    def test_download_options_and_stdout(self):
        options = self.root / 'options.json'
        result = self.run_asr('BV1aaaaaaaaa', ASR_OPTIONS=str(options))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'hello\n')
        opts = json.loads(options.read_text())
        for name in ['noprogress', 'quiet', 'overwrites']:
            self.assertTrue(opts[name])
        self.assertFalse(opts['continuedl'])

    def test_lock_survives_download(self):
        started, release = self.root/'download.started', self.root/'download.release'
        proc = self.start('BV1aaaaaaaaa', ASR_DOWNLOAD_STARTED=str(started),
                          ASR_DOWNLOAD_RELEASE=str(release))
        self.wait_started(started, proc)
        result = self.run_asr('BV1aaaaaaaaa')
        self.assertEqual(result.returncode, 6, result.stderr)
        self.assertEqual(result.stdout, '')
        release.touch()
        out, err = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 0, err.decode())
        self.assertEqual(out.decode().splitlines(), ['hello'])

    def test_equivalent_bv_url_shares_lock(self):
        started, release = self.root/'started', self.root/'release'
        proc = self.start('BV1aaaaaaaaa', ASR_STARTED=str(started), ASR_RELEASE=str(release))
        self.wait_started(started, proc)
        result = self.run_asr('https://www.bilibili.com/video/BV1aaaaaaaaa/')
        self.assertEqual(result.returncode, 6, result.stderr)

    def test_local_absolute_relative_paths_share_lock(self):
        started, release = self.root/'started', self.root/'release'
        proc = self.start(self.audio, ASR_STARTED=str(started), ASR_RELEASE=str(release))
        self.wait_started(started, proc)
        self.assertEqual(self.run_asr('audio.wav').returncode, 6)

    @unittest.skipIf(os.name == 'nt', 'creating symbolic links can require Windows privileges')
    def test_local_symlink_alias_shares_lock(self):
        alias = self.root / 'alias.wav'
        alias.symlink_to(self.audio)
        started, release = self.root/'started', self.root/'release'
        proc = self.start(self.audio, ASR_STARTED=str(started), ASR_RELEASE=str(release))
        self.wait_started(started, proc)
        self.assertEqual(self.run_asr(alias).returncode, 6)

    def test_same_basename_distinct_sources_can_run(self):
        second = self.root / 'other' / 'audio.wav'
        second.parent.mkdir()
        second.write_bytes(b'synthetic audio')
        started, release = self.root/'started', self.root/'release'
        proc = self.start(self.audio, ASR_STARTED=str(started), ASR_RELEASE=str(release))
        self.wait_started(started, proc)
        result = self.run_asr(second)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_killed_local_owner_releases_lock(self):
        started, release = self.root/'started', self.root/'release'
        proc = self.start(self.audio, ASR_STARTED=str(started), ASR_RELEASE=str(release))
        self.wait_started(started, proc)
        self.assertEqual(self.run_asr(self.audio).returncode, 6)
        self.stop(proc)
        result = self.run_asr(self.audio)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_killed_download_is_cleaned_and_retried(self):
        started, release = self.root/'started', self.root/'release'
        proc = self.start('BV1aaaaaaaaa', ASR_DOWNLOAD_STARTED=str(started),
                          ASR_DOWNLOAD_RELEASE=str(release))
        self.wait_started(started, proc)
        self.stop(proc)
        result = self.run_asr('BV1aaaaaaaaa', ASR_CHECK_CLEAN='1')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_output_fails_before_model_and_does_not_poison_retry(self):
        for index, target in enumerate([self.root/'missing'/'out.txt', self.root, '']):
            with self.subTest(output=str(target)):
                started = self.root / ('model-' + str(index))
                result = self.run_asr(self.audio, '-o', target, ASR_STARTED=str(started))
                self.assertEqual(result.returncode, 4, result.stderr)
                self.assertFalse(started.exists())
                retry = self.run_asr(self.audio)
                self.assertEqual(retry.returncode, 0, retry.stderr)

    def test_empty_transcript_has_no_stdout_and_preserves_output(self):
        output = self.root / 'out.txt'
        output.write_text('prior good transcript')
        for args in [(), ('-o', output)]:
            result = self.run_asr(self.audio, *args, ASR_TEXT='')
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertEqual(result.stdout, '')
            self.assertEqual(output.read_text(), 'prior good transcript')

    def test_failed_atomic_replace_preserves_output(self):
        output = self.root / 'out.txt'
        output.write_text('prior good transcript')
        result = self.run_asr(self.audio, '-o', output, ASR_FAIL_REPLACE='1')
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(output.read_text(), 'prior good transcript')
        self.assertEqual(list(self.root.glob('.out.txt.*.tmp')), [])

    def test_successful_output_replaces_old_transcript(self):
        output = self.root / 'out.txt'
        output.write_text('old')
        result = self.run_asr(self.audio, '-o', output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), 'hello')
        self.assertEqual(result.stdout, '')

    def test_default_and_zero_keep_full_transcript(self):
        for args in [(), ('--max-chars', '0')]:
            result = self.run_asr(self.audio, *args, ASR_TEXT='x', ASR_REPEAT='20001')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'x'*20001 + '\n')

    def test_character_cap_includes_marker(self):
        for limit in [1, 5, 7, 8, 11, 12]:
            with self.subTest(limit=limit):
                result = self.run_asr(self.audio, '--max-chars', limit, ASR_TEXT='abcdefghijkl')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(result.stdout.rstrip('\n')), limit)
        result = self.run_asr(self.audio, '--max-chars', '11', ASR_TEXT='short')
        self.assertEqual(result.stdout, 'short\n')
        result = self.run_asr(self.audio, '--max-chars', '5', ASR_TEXT='你好世界🙂，后续正文')
        self.assertEqual(result.stdout, '你好世界🙂\n')

    def test_negative_cap_rejected_before_model(self):
        started = self.root / 'started'
        result = self.run_asr(self.audio, '--max-chars', '-1', ASR_STARTED=str(started))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(started.exists())

    def test_existing_bv_prefixed_file_is_local(self):
        (self.root/'BV1aaaaaaaaa.mp4').write_bytes(b'local')
        result = self.run_asr('BV1aaaaaaaaa.mp4')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_whitespace_wrapped_bv(self):
        result = self.run_asr('  BV1aaaaaaaaa  ')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_actual_download_path_is_used(self):
        result = self.run_asr('BV1aaaaaaaaa', ASR_ALT_PATH='1')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cannot_lock_fails_before_model(self):
        started = self.root / 'started'
        result = self.run_asr(self.audio, ASR_FAIL_LOCK='1', ASR_STARTED=str(started))
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertFalse(started.exists())

    def test_transcription_exception_preserves_output_and_unlocks(self):
        output = self.root / 'out.txt'
        output.write_text('prior good transcript')
        result = self.run_asr(self.audio, '-o', output, ASR_RAISE='1')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(output.read_text(), 'prior good transcript')
        retry = self.run_asr(self.audio)
        self.assertEqual(retry.returncode, 0, retry.stderr)

    @unittest.skipIf(os.name == 'nt', 'non-UTF-8 file names are POSIX-specific')
    def test_non_utf8_local_name(self):
        name = os.fsdecode(os.fsencode(self.root) + b'/audio_\xff.wav')
        with open(name, 'wb') as output:
            output.write(b'local')
        result = self.run_asr(name)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
