"""scripts/deploy_quiet.py: the deploy waits for the user's devices, not for agents on loopback."""
import importlib.util
import sqlite3
import time
from datetime import datetime
from pathlib import Path

_p = Path(__file__).resolve().parents[2] / 'scripts' / 'deploy_quiet.py'
_spec = importlib.util.spec_from_file_location('deploy_quiet', _p)
dq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dq)

NOW = time.time()


def _data(tmp_path, lines=(), session_age_s=None):
    (tmp_path / 'work').mkdir(parents=True)
    log = []
    for ago, ip, method, path in lines:
        ts = datetime.fromtimestamp(NOW - ago).strftime('%Y-%m-%d %H:%M:%S') + ',123'
        log.append(f'{ts} INFO uvicorn.access {ip}:50000 - "{method} {path} HTTP/1.1" 200')
    (tmp_path / 'work' / 'server.log').write_text('\n'.join(log) + '\n')
    c = sqlite3.connect(tmp_path / 'meowsic.db')
    c.execute('CREATE TABLE edit_session (id TEXT, item_id TEXT, started_at INT, beat_at INT)')
    if session_age_s is not None:
        c.execute('INSERT INTO edit_session VALUES (?,?,?,?)', ('s1', 'm-1', int((NOW - 600) * 1000), int((NOW - session_age_s) * 1000)))
    c.commit(); c.close()
    return tmp_path


def test_loopback_agents_do_not_block(tmp_path):
    d = _data(tmp_path, [(5, '127.0.0.1', 'POST', '/api/items/m-1/lyrics'), (3, '127.0.0.1', 'GET', '/api/items'), (2, '::1', 'GET', '/api/jobs')])
    assert dq.check(d, now=NOW) == []


def test_this_macs_own_address_does_not_block(tmp_path):
    d = _data(tmp_path, [(5, '192.168.1.50', 'GET', '/api/items'), (5, '192.168.1.50', 'POST', '/api/items/m-1/check')])
    assert dq.check(d, own=['192.168.1.50'], now=NOW) == []
    assert dq.check(d, now=NOW)  # without --self it is a device like any other


def test_user_device_request_in_5_minutes_blocks(tmp_path):
    d = _data(tmp_path, [(200, '100.119.142.72', 'GET', '/api/items/m-1/pages/1')])
    why = dq.check(d, now=NOW)
    assert len(why) == 1 and '5 quiet minutes' in why[0]
    assert dq.check(_data(tmp_path / 'b', [(400, '192.168.1.11', 'GET', '/api/items')]), now=NOW) == []


def test_background_polls_are_not_activity(tmp_path):
    d = _data(tmp_path, [(10, '192.168.1.11', 'GET', '/api/health'), (10, '192.168.1.11', 'GET', '/api/jobs'), (10, '192.168.1.11', 'GET', '/sw.js')])
    assert dq.check(d, now=NOW) == []


def test_user_device_write_in_2_minutes_blocks(tmp_path):
    d = _data(tmp_path, [(60, '192.168.1.11', 'POST', '/api/items/m-1/editsession')])  # a heartbeat: a write, not "activity"
    why = dq.check(d, now=NOW)
    assert len(why) == 1 and '2 minutes' in why[0]
    assert dq.check(_data(tmp_path / 'b', [(150, '192.168.1.11', 'POST', '/api/items/m-1/editsession')]), now=NOW) == []


def test_edit_session_blocks_whoever_holds_it(tmp_path):
    d = _data(tmp_path, [(5, '127.0.0.1', 'POST', '/api/items/m-1/editsession')], session_age_s=10)
    why = dq.check(d, now=NOW)
    assert len(why) == 1 and 'edit session' in why[0] and 'm-1' in why[0]
    assert dq.check(_data(tmp_path / 'b', session_age_s=200), now=NOW) == []  # no heartbeat for 2 min: over


def test_no_log_no_db(tmp_path):
    assert dq.check(tmp_path, now=NOW) == []
