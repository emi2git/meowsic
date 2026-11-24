"""The page carries the version it was built with (<meta name="meowsic-build">), so web/js/update.js can tell an
old page (an old saved shell, a window left open) from the code the Mac serves now."""
from meowsic.version import version


def test_index_is_stamped_with_shell_and_sha(client):
    v = version()
    for path in ('/', '/index.html'):
        r = client.get(path)
        assert r.status_code == 200
        assert f'<meta name="meowsic-build" content="{v["shell"]} {v["sha"]}">' in r.text
        assert r.headers['cache-control'] == 'no-store'
    assert v['shell'].startswith('meowsic-shell-v')


def test_health_matches_the_stamp(client):
    h = client.get('/api/health').json()
    assert f'content="{h["shell"]} {h["sha"]}"' in client.get('/').text
