#!/bin/bash
cd "$(dirname "$0")"
cp .env.sebas .env
export PATH="/opt/homebrew/bin:$PATH"
exec node src/server.js
