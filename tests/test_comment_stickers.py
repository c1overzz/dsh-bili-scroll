"""Offline only: imports the real MCP and API library, substitutes every network boundary."""
import asyncio
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image

HERE = Path(__file__).resolve().parent
os.environ['BILI_MCP_TOOLS'] = 'bili_search,bili_subtitle,bili_comments,bili_video_info,bili_reply,bili_stickers'
spec = importlib.util.spec_from_file_location('bili_sticker_under_test', HERE.parent / 'vendor' / 'bilibili-mcp' / 'mcp_server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeCredential:
    def raise_for_no_sessdata(self): pass
    def raise_for_no_bili_jct(self): pass


class FakeVideo:
    calls = 0
    def __init__(self, **kwargs): pass
    async def get_info(self):
        FakeVideo.calls += 1
        return {'aid': 170001}


class OfflineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bili-sticker-test-')
        self.root = Path(self.temp.name)
        self.library = self.root / 'library'; self.library.mkdir()
        Image.new('RGBA', (1200, 900), (10, 40, 220, 80)).save(self.library / '乖巧_等你.png')
        Image.new('RGB', (128, 128), 'red').save(self.library / '开心_笑.webp')
        frames = [Image.new('RGB', (100, 100), color) for color in ['red', 'blue']]
        frames[0].save(self.library / '委屈_动图.gif', save_all=True, append_images=frames[1:], duration=100, loop=0)
        self.rows = [dict(filename=n, emotion=n.split('_')[0], content=n.split('_')[1], animated=n.endswith('.gif'))
                     for n in ['乖巧_等你.png', '开心_笑.webp', '委屈_动图.gif']]
        self.write_index()
        self.config = self.root / 'comment-stickers.json'
        self.config.write_text(json.dumps(dict(directory=str(self.library), default='乖巧_等你.png')), encoding='utf8')
        self.patches = [patch.object(server, '_STICKER_CONFIG', self.config),
                        patch.object(server, 'get_cred', return_value=FakeCredential()),
                        patch.object(server.video, 'Video', FakeVideo)]
        for p in self.patches: p.start()
        FakeVideo.calls = 0
        self.uploads = []; self.posts = []; self.upload_error = None; self.post_error = None
        outer = self

        class FakeApi:
            def __init__(self, **kwargs): self.data = {}; self.files = {}
            def update_data(self, **kwargs): self.data.update(kwargs); return self
            def update_files(self, **kwargs): self.files.update(kwargs); return self
            @property
            def result(self): return self.run()
            async def run(self):
                if self.files:
                    upload = self.files['file_up']; path = Path(upload.path)
                    self_bytes = path.read_bytes()
                    with Image.open(path) as im:
                        im.load()
                        assert im.format == 'PNG' and getattr(im, 'n_frames', 1) == 1
                        assert max(im.size) <= 768
                        dimensions = im.size
                    outer.uploads.append(dict(path=str(path), mime=upload.mime_type,
                                              sha256=hashlib.sha256(self_bytes).hexdigest(), dimensions=dimensions))
                    await asyncio.sleep(0.01)
                    assert path.read_bytes() == self_bytes, 'concurrent upload changed our picture'
                    if outer.upload_error: raise outer.upload_error
                    return dict(image_url='https://offline.invalid/picture.png', image_width=dimensions[0],
                                image_height=dimensions[1], img_size=len(self_bytes)/1024)
                outer.posts.append(dict(self.data))
                if self.data.get('root') and self.data.get('pictures'):
                    raise RuntimeError('-400: 子评论不能带图')
                if outer.post_error: raise outer.post_error
                return dict(rpid=99001 + len(outer.posts), rpid_str=str(99001 + len(outer.posts)),
                            root=self.data.get('root', 0), parent=self.data.get('parent', 0))

        self.api_patches = [patch.object(server.dynamic, 'Api', FakeApi), patch.object(server.comment, 'Api', FakeApi)]
        for p in self.api_patches: p.start()

    def write_index(self):
        (self.library/'表情索引.json').write_text(json.dumps(dict(items=self.rows)), encoding='utf8')

    def tearDown(self):
        for p in reversed(self.api_patches + self.patches): p.stop()
        self.temp.cleanup()

    async def send(self, **kwargs):
        return json.loads(await server.bili_reply('BVoffline', '@测试 主人，诶这条好玩呀 (｡･ω･｡)\n@朋友 来看看', **kwargs))

    def assert_clean(self):
        for upload in self.uploads: self.assertFalse(Path(upload['path']).exists())

    async def test_main_comment_uploads_one_picture_and_keeps_receipt(self):
        result = await self.send(sticker='开心_笑.webp')
        self.assertTrue(result['success'], result)
        self.assertEqual(result['sticker'], '开心_笑.webp')
        self.assertIn('rpid', result)
        self.assertEqual(len(self.uploads), 1); self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]['message'], '@测试 主人，诶这条好玩呀 (｡･ω･｡)\n@朋友 来看看')
        self.assertEqual(len(json.loads(self.posts[0]['pictures'])), 1)
        self.assertNotIn('root', self.posts[0]); self.assertNotIn('parent', self.posts[0])
        self.assert_clean()

    async def test_child_replies_are_text_only_and_preserve_receipts(self):
        for args in [dict(rpid=71), dict(rpid=72, root=70)]:
            for sticker in ['', '开心_笑.webp', '../missing.png']:
                result = await self.send(sticker=sticker, **args)
                self.assertTrue(result['success'], result)
                self.assertEqual(result['sticker'], '')
                self.assertEqual(result['sticker_skip_reason'], 'bilibili_child_reply_no_images')
                self.assertEqual(result['parent'], args['rpid'])
                self.assertEqual(result['root'], args.get('root', args['rpid']))
                self.assertEqual(result['rpid_str'], str(result['rpid']))
        self.assertEqual(len(self.posts), 6); self.assertEqual(self.uploads, [])
        for post in self.posts:
            self.assertNotIn('pictures', post)
            self.assertEqual(post['message'], '@测试 主人，诶这条好玩呀 (｡･ω･｡)\n@朋友 来看看')

    async def test_child_replies_do_not_read_sticker_configuration(self):
        self.config.write_text('{', encoding='utf8')
        with patch.object(server, '_sticker_catalog', side_effect=AssertionError('reply must not read the image library')):
            result = await self.send(rpid=72, root=70, sticker='missing.png')
        self.assertTrue(result['success'], result)
        self.config.unlink()
        self.assertTrue((await self.send(rpid=71, sticker='missing.png'))['success'])
        self.assertEqual(len(self.posts), 2); self.assertEqual(self.uploads, [])

    async def test_child_reply_timeout_is_never_retried(self):
        self.post_error = TimeoutError('offline result unknown')
        result = await self.send(rpid=72, root=70, sticker='开心_笑.webp')
        self.assertFalse(result['success']); self.assertFalse(result['retry_safe'])
        self.assertEqual(result['stage'], 'send')
        self.assertEqual(len(self.posts), 1); self.assertEqual(self.uploads, [])
        self.assertNotIn('pictures', self.posts[0])

    async def test_missing_argument_defaults_and_emotion_selection(self):
        default = await self.send(); self.assertEqual(default['sticker'], '乖巧_等你.png')
        by_emotion = await self.send(sticker='开心'); self.assertEqual(by_emotion['sticker'], '开心_笑.webp')
        self.assertEqual(self.uploads[0]['dimensions'], (768, 576))
        self.assertEqual(len(self.posts), 2); self.assert_clean()

    async def test_invalid_selection_and_broken_config_fail_before_network(self):
        for choice in ['../private.png', '/tmp/private.png', 'missing.png', '不存在的情绪']:
            result = await self.send(sticker=choice)
            self.assertFalse(result['success']); self.assertEqual(result['stage'], 'prepare')
        self.config.write_text('{', encoding='utf8')
        self.assertFalse((await self.send())['success'])
        self.assertEqual(FakeVideo.calls, 0); self.assertEqual(self.uploads, []); self.assertEqual(self.posts, [])

    async def test_catalog_readonly_and_whitelist_discovers_new_tool(self):
        result = json.loads(await server.bili_stickers())
        self.assertTrue(result['ok']); self.assertEqual(result['total'], 2)
        self.assertNotIn(str(self.library), json.dumps(result))
        self.assertEqual(json.loads(await server.bili_stickers(emotion='开心'))['items'][0]['filename'], '开心_笑.webp')
        self.assertEqual(json.loads(await server.bili_stickers(query='委屈_动图.gif'))['total'], 1)
        tools = await server.mcp.list_tools()
        schema = {t.name: t.inputSchema for t in tools}
        self.assertIn('bili_stickers', schema)
        self.assertIn('sticker', schema['bili_reply']['properties'])
        self.assertEqual(self.uploads, []); self.assertEqual(self.posts, [])

    async def test_upload_failure_never_posts_text_or_retries(self):
        self.upload_error = RuntimeError('offline upload rejected')
        result = await self.send()
        self.assertFalse(result['success']); self.assertFalse(result['retry_safe'])
        self.assertEqual(result['stage'], 'send')
        self.assertEqual(len(self.uploads), 1); self.assertEqual(len(self.posts), 0)
        self.assert_clean()

    async def test_post_timeout_never_retries_or_downgrades(self):
        self.post_error = TimeoutError('offline result unknown')
        result = await self.send()
        self.assertFalse(result['success']); self.assertFalse(result['retry_safe'])
        self.assertEqual(len(self.uploads), 1); self.assertEqual(len(self.posts), 1)
        self.assertIn('pictures', self.posts[0]); self.assert_clean()

    async def test_gif_becomes_static_png_without_changing_original(self):
        src = self.library/'委屈_动图.gif'; before = src.read_bytes()
        result = await self.send(sticker=src.name)
        self.assertTrue(result['success'], result)
        self.assertEqual(result['sticker_rendering'], 'gif_first_frame')
        self.assertEqual(src.read_bytes(), before)
        self.assertEqual(self.uploads[0]['mime'], 'image/png'); self.assert_clean()

    async def test_concurrent_requests_use_separate_upload_paths(self):
        result = await asyncio.gather(self.send(sticker='开心_笑.webp'), self.send(sticker='乖巧_等你.png'))
        self.assertTrue(all(x['success'] for x in result), result)
        self.assertEqual(len({u['path'] for u in self.uploads}), 2)
        self.assertEqual(len({u['sha256'] for u in self.uploads}), 2)
        self.assertEqual(len(self.posts), 2); self.assert_clean()

    async def test_symlink_cannot_upload_outside_library(self):
        outside = self.root/'private.png'; Image.new('RGB', (100,100)).save(outside)
        (self.library/'开心_外链.png').symlink_to(outside)
        self.rows.append(dict(filename='开心_外链.png', emotion='开心', content='外链'))
        self.write_index()
        result = await self.send(sticker='开心_外链.png')
        self.assertFalse(result['success']); self.assertEqual(result['stage'], 'prepare')
        self.assertEqual(FakeVideo.calls, 0); self.assertEqual(self.uploads, []); self.assertEqual(self.posts, [])

    async def test_unconfigured_comments_keep_the_original_text_only_payload(self):
        self.config.unlink()
        for args in [{}, dict(rpid=71), dict(rpid=72, root=70)]:
            result = await self.send(**args)
            self.assertTrue(result['success'], result)
            if args:
                self.assertEqual(result['sticker'], '')
            else:
                self.assertNotIn('sticker', result)
        self.assertEqual(self.uploads, []); self.assertEqual(len(self.posts), 3)
        self.assertTrue(all('pictures' not in row for row in self.posts))
        catalog = json.loads(await server.bili_stickers())
        self.assertTrue(catalog['ok']); self.assertFalse(catalog['configured'])

    async def test_explicit_image_without_config_fails_before_any_network(self):
        self.config.unlink()
        result = await self.send(sticker='开心_笑.webp')
        self.assertFalse(result['success']); self.assertEqual(result['stage'], 'prepare')
        self.assertEqual(FakeVideo.calls, 0); self.assertEqual(self.posts, []); self.assertEqual(self.uploads, [])

    async def test_plain_directory_relative_to_config_needs_no_index(self):
        (self.library/'表情索引.json').unlink()
        self.config.write_text(json.dumps(dict(directory='library', default='乖巧_等你.png')), encoding='utf8')
        result = json.loads(await server.bili_stickers(emotion='开心'))
        self.assertTrue(result['configured']); self.assertEqual(result['items'][0]['content'], '笑')
        self.assertTrue((await self.send(sticker='开心'))['success'])

    async def test_index_metadata_enriches_existing_files_with_clear_precedence(self):
        rows=[dict(filename='开心_笑.webp', emotion='庆祝', content='欢呼'),
              dict(filename='missing.png', emotion='庆祝', content='not a real file')]
        (self.library/'index.json').write_text(json.dumps(dict(items=rows)), encoding='utf8')
        result=json.loads(await server.bili_stickers(emotion='庆祝'))
        self.assertEqual(result['total'], 1); self.assertEqual(result['items'][0]['content'], '欢呼')
        self.assertEqual(json.loads(await server.bili_stickers(emotion='开心'))['total'], 0)

    async def test_incomplete_existing_config_never_sends_plaintext(self):
        for value in [{},dict(directory=''),dict(directory='missing',default='neutral.png'),
                      dict(directory=str(self.library),default='missing.png')]:
            with self.subTest(config=value):
                self.config.write_text(json.dumps(value),encoding='utf8')
                result=await self.send()
                self.assertFalse(result['success']); self.assertEqual(result['stage'],'prepare')
        self.assertEqual(FakeVideo.calls,0);self.assertEqual(self.posts,[]);self.assertEqual(self.uploads,[])

    async def test_invalid_metadata_and_corrupt_images_fail_before_network(self):
        index=self.library/'表情索引.json'
        index.write_text(json.dumps(dict(items={})),encoding='utf8')
        self.assertFalse((await self.send())['success'])
        index.unlink()
        (self.library/'开心_坏图.png').write_bytes(b'not an image')
        self.assertFalse((await self.send(sticker='开心_坏图.png'))['success'])
        self.assertEqual(FakeVideo.calls,0);self.assertEqual(self.posts,[]);self.assertEqual(self.uploads,[])

    async def test_config_removal_restores_plaintext_in_the_same_mcp(self):
        self.assertTrue((await self.send())['success'])
        self.config.unlink()
        self.assertTrue((await self.send())['success'])
        self.assertEqual(len(self.uploads),1);self.assertEqual(len(self.posts),2)
        self.assertIn('pictures',self.posts[0]);self.assertNotIn('pictures',self.posts[1])

    async def test_broken_config_symlink_is_not_treated_as_unconfigured(self):
        self.config.unlink();self.config.symlink_to(self.root/'missing.json')
        self.assertFalse((await self.send())['success'])
        self.assertEqual(FakeVideo.calls,0);self.assertEqual(self.posts,[]);self.assertEqual(self.uploads,[])


if __name__ == '__main__': unittest.main(verbosity=2)
