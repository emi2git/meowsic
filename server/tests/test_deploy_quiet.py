"""scripts/deploy_quiet.py: the deploy waits for the user's devices, not for agents on loopback."""
import importlib.util
import sqlite3
import time
from datetime import datetime
from pathlib import Path

import pytest

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


IFCONFIG = """lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
	inet6 ::1 prefixlen 128
	inet 100.95.140.90 netmask 0xffffffff
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet6 fe80::1c4e:23e7:1380:c66a%en0 prefixlen 64 secured scopeid 0xe
	inet 192.168.1.50 netmask 0xffffff00 broadcast 192.168.1.255
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
	inet 100.74.199.55 --> 100.74.199.55 netmask 0xffffffff
	inet6 fd7a:115c:a1e0::ca37:c738 prefixlen 48
"""
MEOWSIC_TS = '100.95.140.90\nfd7a:115c:a1e0::3037:8c5b\n'


def test_only_the_meowsic_tailnet_ip_is_this_mac():
    own = dq.self_addresses(IFCONFIG, MEOWSIC_TS)
    assert {'192.168.1.50', '100.95.140.90', 'fd7a:115c:a1e0::3037:8c5b'} <= own
    assert '100.74.199.55' not in own and 'fd7a:115c:a1e0::ca37:c738' not in own  # Tailscale.app's other node
    assert dq.self_addresses(IFCONFIG, '') & {'100.74.199.55', '100.95.140.90'} == set()  # no Meowsic node: no tailnet IP


def test_other_tailnet_node_on_this_mac_counts_as_a_device(tmp_path):
    own = dq.self_addresses(IFCONFIG, MEOWSIC_TS)
    assert dq.check(_data(tmp_path, [(5, '100.95.140.90', 'GET', '/api/items')]), own=own, now=NOW) == []
    assert dq.check(_data(tmp_path / 'b', [(5, '100.74.199.55', 'GET', '/api/items')]), own=own, now=NOW)


def test_allowlist(tmp_path, monkeypatch):
    own = dq.self_addresses('', '', allow=['100.74.199.55, 10.0.0.9', ' ', 'junk'])
    assert own == {'100.74.199.55', '10.0.0.9'}
    d = _data(tmp_path, [(5, '10.0.0.9', 'GET', '/api/items')])
    monkeypatch.setattr(dq, '_run', lambda cmd: '')
    monkeypatch.setenv('MEOWSIC_SELF_IPS', '10.0.0.9')
    assert dq.main([str(d)]) == 0
    monkeypatch.delenv('MEOWSIC_SELF_IPS')
    assert dq.main([str(d)]) == 1
    assert dq.main([str(d), '--self', '10.0.0.9']) == 0


def test_mode_ro_failure_falls_back_to_query_only(tmp_path, monkeypatch):
    d = _data(tmp_path, session_age_s=10)
    real = sqlite3.connect

    def connect(path, *a, **k):
        if 'mode=ro' in str(path):
            raise sqlite3.OperationalError('unable to open database file')
        return real(path, *a, **k)
    monkeypatch.setattr(dq.sqlite3, 'connect', connect)
    assert [r[0] for r in dq.sessions(d / 'meowsic.db', NOW)] == ['m-1']
    c = dq._open(d / 'meowsic.db')
    try:
        with pytest.raises(sqlite3.OperationalError):
            c.execute('DELETE FROM edit_session')  # query_only: no writes
    finally:
        c.close()


def test_errors_fail_closed_one_line(tmp_path, monkeypatch, capsys):
    d = _data(tmp_path)
    monkeypatch.setattr(dq, '_run', lambda cmd: '')
    real = sqlite3.connect

    def boom(*a, **k): raise sqlite3.OperationalError('unable to open database file')
    monkeypatch.setattr(dq.sqlite3, 'connect', boom)
    assert dq.main([str(d)]) == 2
    err = capsys.readouterr().err
    assert err.count('\n') == 1 and 'refusing to deploy' in err and 'Traceback' not in err
    assert dq.main([str(d), '--dry-run']) == 0
    out = capsys.readouterr().out
    assert out.startswith('cannot check') and out.count('\n') == 1
    monkeypatch.setattr(dq.sqlite3, 'connect', real)
    (d / 'meowsic.db').write_bytes(b'not a database' * 400)  # a broken DB, not only a failed open
    assert dq.main([str(d)]) == 2
    assert capsys.readouterr().err.startswith('deploy_quiet: cannot check')


def test_dry_run_only_reports(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dq, '_run', lambda cmd: '')
    d = _data(tmp_path, [(5, '192.168.1.11', 'GET', '/api/items')], session_age_s=10)
    assert dq.main([str(d), '--dry-run']) == 0
    out = capsys.readouterr().out
    assert out.startswith('not quiet: ') and 'edit session' in out and '5 quiet minutes' in out
    assert dq.main([str(d)]) == 1
    assert dq.main([str(_data(tmp_path / 'b')), '--dry-run']) == 0
    assert capsys.readouterr().out == 'quiet\n'
