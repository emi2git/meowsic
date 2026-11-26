"""scripts/test-all makes the fake Photos album (photoimport, cropback suites) with the server venv's python, which
has PIL: the default python3 has none, and the suites failed at setup."""
import importlib.machinery
import importlib.util
import subprocess
from pathlib import Path

_p = Path(__file__).resolve().parents[2] / 'scripts' / 'test-all'
_loader = importlib.machinery.SourceFileLoader('test_all_script', str(_p))
_spec = importlib.util.spec_from_loader('test_all_script', _loader)
ta = importlib.util.module_from_spec(_spec)
_loader.exec_module(ta)


def test_album_uses_the_server_venv_python(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(ta.subprocess, 'run', lambda cmd, **k: seen.append(cmd))
    ta.make_album(tmp_path / 'a')
    assert seen and seen[0][0] == str(ta.dev.PY) and seen[0][1].endswith('make_fake_album.py')


def test_album_is_made(tmp_path):
    album = tmp_path / 'fake-album'
    ta.make_album(album)
    assert len(list((album / 'SHEET').glob('*.*'))) >= 7
