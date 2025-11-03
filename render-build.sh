#!/usr/bin/env bash
set -e

# Make sure we’re using npm and package.json (ignore any old lockfiles)
rm -f yarn.lock pnpm-lock.yaml

# Clean install using package.json versions
npm install --no-audit --no-fund
