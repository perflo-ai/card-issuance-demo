#!/bin/sh
# Self-signed certificate for https://localhost (the demo on 5174 and the mock on 8791).
# Browsers show a warning once; accept it for each port. For a trusted cert, use mkcert instead (see README).
set -eu
cd "$(dirname "$0")/.."
mkdir -p certs
if [ -f certs/localhost.pem ] && [ -f certs/localhost-key.pem ]; then
  echo "certs/localhost.pem already exists"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout certs/localhost-key.pem -out certs/localhost.pem 2>/dev/null
chmod 600 certs/localhost-key.pem
echo "Wrote certs/localhost.pem and certs/localhost-key.pem"
