#!/bin/sh
# Copies the add-on scripts next to the fake @minecraft/* modules and runs the smoke test.
cd "$(dirname "$0")" && rm -rf _run && cp -r ../BP/scripts _run && node smoke.test.js
