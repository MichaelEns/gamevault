# GameVault container.
#
# Node for the app, plus Python for the legendary CLI (Epic ownership).
# Python is genuinely optional -- if you never link Epic it is dead weight,
# but it is ~50 MB and baking it in avoids a second image variant.

FROM node:22-alpine

# legendary (Epic) and nile (Amazon Games / Prime Gaming) are OPTIONAL.
# Install best-effort: a network that blocks PyPI -- corporate egress
# filtering, an air-gapped builder -- must not fail the whole image over
# optional providers. When absent, the app reports them as unavailable and
# everything else works.
RUN apk add --no-cache python3 py3-pip ca-certificates git \
    && python3 -m venv /opt/clients \
    && ( /opt/clients/bin/pip install --no-cache-dir --disable-pip-version-check legendary-gl \
         && echo "legendary: installed" || echo "legendary: SKIPPED (PyPI unreachable)" ) \
    && ( /opt/clients/bin/pip install --no-cache-dir --disable-pip-version-check \
              "git+https://github.com/imLinguin/nile.git" \
         && echo "nile: installed" || echo "nile: SKIPPED (PyPI/GitHub unreachable)" ) \
    || echo "optional game clients skipped"

WORKDIR /app

# No runtime npm dependencies, so this is just source.
COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY test ./test

# legendary keeps its OAuth token here; mount a volume so a redeploy does
# not log you out of Epic.
ENV LEGENDARY_CONFIG_PATH=/data/legendary
ENV GAMEVAULT_LEGENDARY_BIN=/opt/clients/bin/legendary
ENV GAMEVAULT_NILE_BIN=/opt/clients/bin/nile
# nile stores its token under XDG_CONFIG_HOME; keep it on the volume too.
ENV XDG_CONFIG_HOME=/data/config

# data/ holds the library, cached prices, sessions and the session secret.
VOLUME ["/data"]

# Bind to all interfaces inside the container. The startup guard in
# lib/auth.mjs refuses to do this unless a password is configured.
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# Run unprivileged.
RUN addgroup -S gv && adduser -S gv -G gv \
    && mkdir -p /data && chown -R gv:gv /data /app
USER gv

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "server.mjs"]
