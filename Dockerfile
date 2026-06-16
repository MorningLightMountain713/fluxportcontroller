# Image for the integration harness: builds the local fluxport-controller and
# runs either a node (test_entrypoint.ts) or the verifier (observer.ts), chosen
# by the compose `command`. Runs the TypeScript directly via tsx.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY test_entrypoint.ts observer.ts ./

# installs deps and runs the `prepare` build (tsc) to validate the source
RUN npm install

CMD ["node", "--import", "tsx", "test_entrypoint.ts"]
