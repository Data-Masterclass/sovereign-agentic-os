# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""A stand-in LiteLLM admin API for scripts/tests/gateway-live.test.sh (stdlib only, no network beyond loopback).

  python3 gateway-stub.py <state.json> <port-file>
Serves GET /model/info, /router/settings, /key/list and POST /model/new from <state.json> (rows, aliases,
keys), checks the Bearer token against STUB_MASTER_KEY, appends every POST body to <state.json>.posts and
writes the port it listens on to <port-file>. The rows deliberately carry secret-looking values (an api_key,
a key's token) so the test can prove the helper never prints them.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE, PORT_FILE = sys.argv[1], sys.argv[2]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _ok(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth(self):
        if self.headers.get('Authorization') != 'Bearer ' + os.environ['STUB_MASTER_KEY']:
            self.send_response(401)
            self.end_headers()
            return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        st = json.load(open(STATE))
        if self.path.startswith('/model/info'):
            return self._ok({'data': st['rows']})
        if self.path.startswith('/router/settings'):
            return self._ok({'current_values': {'model_group_alias': st.get('aliases', {})}})
        if self.path.startswith('/key/list'):
            return self._ok({'keys': st.get('keys', []), 'total_pages': 1})
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if not self._auth():
            return
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        st = json.load(open(STATE))
        st.setdefault('posts', []).append({'path': self.path, 'body': body})
        st['rows'].append({'model_name': body['model_name'], 'litellm_params': body['litellm_params'],
                           'model_info': dict(body.get('model_info') or {}, db_model=True, id='new-%d' % len(st['posts']))})
        json.dump(st, open(STATE, 'w'))
        self._ok({'model_id': 'new-%d' % len(st['posts']), 'model_name': body['model_name']})


srv = HTTPServer(('127.0.0.1', 0), H)
open(PORT_FILE, 'w').write(str(srv.server_address[1]))
srv.serve_forever()
