# Image for the integration harness: the fluxport-controller node under test,
# run straight from TypeScript via tsx. The testcontainers harness builds this
# once and starts N of them on one bridge network alongside a miniupnpd "router",
# then verifies the consensus by polling each node's status endpoint.
FROM node:26-trixie-slim

WORKDIR /app

# Chaos tooling for the integration harness, run in each container's own netns via
# NET_ADMIN: iptables does both partition (DROP by peer source-IP) and packet loss
# (the `statistic` match). The legacy backend is selected because the nft backend
# is unreliable inside containers; tc/netem isn't used (Docker Desktop's kernel has
# no sch_netem). Harness image only — never shipped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables \
 && update-alternatives --set iptables /usr/sbin/iptables-legacy \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY test_entrypoint.ts ./

# Runtime deps only, as the lockfile pins them: --omit=dev keeps the test-only deps
# (testcontainers and its native transitive deps) out of the node image;
# --ignore-scripts skips the `prepare` build, since the container runs the source
# via tsx, not build/.
# tsx is installed GLOBALLY as a CLI — it can't be a local --omit=dev install
# (it's a devDependency, so --omit=dev would drop it), and global avoids the
# `node --import tsx` resolve-from-/app problem.
RUN npm ci --omit=dev --ignore-scripts \
 && npm install -g tsx@^4.23.15

CMD ["tsx", "test_entrypoint.ts"]
