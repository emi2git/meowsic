#!/bin/zsh
# Start Meowsic for daily use: real library in ~/Documents/Meowsic, HTTPS when the certificate exists
# (needed on iPad / iPhone for the offline library). Port 5180.
CERTS="$HOME/Documents/Meowsic/certs"
if [[ -f "$CERTS/server.pem" && -f "$CERTS/server.key" ]]; then
  export MEOWSIC_CERT="$CERTS/server.pem" MEOWSIC_KEY="$CERTS/server.key"
fi
exec "${0:A:h}/run.sh" --port "${MEOWSIC_PORT:-5180}" "$@"
