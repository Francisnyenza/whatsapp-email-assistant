#!/usr/bin/env python3
"""A stand-in for the WhatsApp Cloud API.

Records every send to meta-capture.jsonl and answers the way Meta does, so the
outbound half of the loop can be exercised without egress.
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURE = os.path.join(HERE, 'meta-capture.jsonl')
COUNT = [0]

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw)
        except Exception:
            body = {'_raw': raw.decode('utf-8', 'replace')}

        COUNT[0] += 1
        wamid = f"wamid.STUB.{COUNT[0]:04d}"
        with open(CAPTURE, 'a') as f:
            f.write(json.dumps({'path': self.path, 'wamid': wamid, 'body': body}) + '\n')

        reply = json.dumps({
            'messaging_product': 'whatsapp',
            'contacts': [{'input': body.get('to', ''), 'wa_id': body.get('to', '')}],
            'messages': [{'id': wamid, 'message_status': 'accepted'}],
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass

if __name__ == '__main__':
    open(CAPTURE, 'w').close()
    HTTPServer(('127.0.0.1', 4010), Handler).serve_forever()
