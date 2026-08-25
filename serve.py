#!/usr/bin/env python3
"""Serve public/ for local development, without letting anything go stale.

``python3 -m http.server`` sends no cache headers at all, so browsers apply their
own heuristics and happily keep serving yesterday's eclipse data after a rebuild.
This sends ``no-store``, which costs nothing locally and saves a lot of confusion.

    python3 serve.py [port] [--bind ADDR]
"""

import argparse
import functools
import http.server
import os


class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)      # only complain about failures


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--bind", default="0.0.0.0",
                    help="address to listen on; pass a Tailscale IP to keep it "
                         "off the local network")
    args = ap.parse_args()

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
    handler = functools.partial(NoStore, directory=root)
    server = http.server.ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"serving {root} on http://{args.bind}:{args.port}/  (ctrl-c to stop)")
    server.serve_forever()


if __name__ == "__main__":
    main()
