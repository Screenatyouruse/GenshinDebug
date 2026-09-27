#!/usr/bin/env python3
"""port.json -> cppport config on stdout. Thin wrapper over cfgkeys.emit (single source)."""
import json
import sys

import cfgkeys

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: port2config.py <port.json>")
    sys.stdout.write(cfgkeys.emit(json.load(open(sys.argv[1], encoding="utf-8"))))
