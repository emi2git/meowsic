"""python -m meowsic  — env: MEOWSIC_PORT (5180), MEOWSIC_HOST (0.0.0.0), MEOWSIC_DATA, MEOWSIC_CERT/MEOWSIC_KEY (HTTPS)."""
import argparse
import logging
import os
from pathlib import Path

import uvicorn

from .app import create_app

p = argparse.ArgumentParser(prog='meowsic')
p.add_argument('--port', type=int, default=int(os.environ.get('MEOWSIC_PORT', 5180)))
p.add_argument('--host', default=os.environ.get('MEOWSIC_HOST', '0.0.0.0'))
p.add_argument('--data', default=None, help='data folder (default ~/Documents/Meowsic or $MEOWSIC_DATA)')
a = p.parse_args()

log = Path.home() / 'Library' / 'Logs' / 'Meowsic.log'
log.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(handlers=[logging.FileHandler(log), logging.StreamHandler()], level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')

cert, key = os.environ.get('MEOWSIC_CERT'), os.environ.get('MEOWSIC_KEY')
tls = dict(ssl_certfile=cert, ssl_keyfile=key) if cert and key else {}
uvicorn.run(create_app(a.data), host=a.host, port=a.port, log_config=None, **tls)
