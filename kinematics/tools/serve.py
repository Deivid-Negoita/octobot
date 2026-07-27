"""Dev server: static files with caching disabled (so edits always load).

Serves the kinematics/ folder — the parent of this script — because ES modules
cannot load over file://. Run it from anywhere:

    python tools/serve.py [port]

Also accepts POST /__snapshot with a base64 canvas data-URL body and writes it
to snapshots/latest.png — lets tooling inspect the WebGL render headlessly.
"""
import base64
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_POST(self):
        if self.path != '/__snapshot':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('ascii', errors='ignore')
        b64 = body.split(',', 1)[1] if ',' in body else body
        os.makedirs('snapshots', exist_ok=True)
        with open(os.path.join('snapshots', 'latest.png'), 'wb') as f:
            f.write(base64.b64decode(b64))
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    print(f'IK Workbench at http://localhost:{port}')
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
