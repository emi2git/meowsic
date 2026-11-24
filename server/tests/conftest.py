import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Hard guard: anything that falls back to the default data folder gets a throwaway one, never ~/Documents/Meowsic.
os.environ['MEOWSIC_DATA'] = tempfile.mkdtemp(prefix='meowsic-pytest-default-')

from meowsic.app import create_app  # noqa: E402


@pytest.fixture
def data(tmp_path):
    d = tmp_path / 'Meowsic'
    d.mkdir()
    # stand-ins for the old app's files, which must never be touched
    (d / 'Meowsic.store').write_bytes(b'old store')
    (d / '.Meowsic_SUPPORT').mkdir()
    (d / '.Meowsic_SUPPORT' / 'x').write_bytes(b'old support')
    return d


@pytest.fixture
def app(data):
    return create_app(data, background=False)


@pytest.fixture
def client(app, data):
    with TestClient(app) as c:
        yield c
    assert (data / 'Meowsic.store').read_bytes() == b'old store'
    assert (data / '.Meowsic_SUPPORT' / 'x').read_bytes() == b'old support'


@pytest.fixture
def chord(client):
    return client.post('/api/items', json={'kind': 'chords', 'title': 'Amazing Grace', 'artist': 'John Newton',
                                           'text': 'A[G]mazing grace', 'key': 'G', 'source': 'pasted', 'tags': ['Folk']}).json()
