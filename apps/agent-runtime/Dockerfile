# syntax=docker/dockerfile:1
# Agent runtime image (C3, P0-WP4): one bundled file on a Node.js 22 base.
# Hard rule 6: the base image must be pinned by digest, e.g.
#   docker build --build-arg BASE_IMAGE=node:22-alpine@sha256:<digest> -t <name> apps/agent-runtime
# Build the bundle first: pnpm --filter @adlc/agent-runtime build:bundle
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
RUN case "${BASE_IMAGE}" in *@sha256:*) ;; *) echo "BASE_IMAGE must be pinned by digest" >&2; exit 1 ;; esac
LABEL org.opencontainers.image.title="adlc-agent-runtime" adlc.component="agent-runtime"
COPY dist-bundle/ /opt/adlc/
WORKDIR /workspace
# Runs as the same unprivileged user the executor enforces; the root filesystem is read-only at run time.
USER 65532:65532
ENTRYPOINT ["node", "/opt/adlc/agent.mjs"]
