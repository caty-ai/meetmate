#!/bin/bash
cd "$(dirname "$0")"
cp .env.claire .env
export PATH="/opt/homebrew/bin:$PATH"
exec node src/server.js
