# Image for the integration harness: the fluxport-controller node under test,
# run straight from TypeScript via tsx. The testcontainers harness builds this
# once and starts N of them on one bridge network alongside a miniupnpd "router",
# then verifies the consensus by polling each node's status endpoint.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY test_entrypoint.ts ./

# Runtime deps only: --omit=dev keeps the test-only deps (testcontainers and its
# native transitive deps) out of the node image; --ignore-scripts skips the
# `prepare` build, since the container runs the source via tsx, not build/.
# tsx is installed GLOBALLY as a CLI — it can't be a local --omit=dev install
# (it's a devDependency, so --omit=dev would drop it), and global avoids the
# `node --import tsx` resolve-from-/app problem.
RUN npm install --omit=dev --ignore-scripts \
 && npm install -g tsx@^4.22.4

CMD ["tsx", "test_entrypoint.ts"]
