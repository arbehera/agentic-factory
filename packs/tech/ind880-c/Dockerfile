# syntax=docker/dockerfile:1
# Toolchain image SKELETON for the ind880-c pack (P0-WP8, SDD F.2).
#  - OPEN-04: no SDK or RTOS files are included until licence and NDA terms are cleared.
#  - OPEN-15: the target compiler is not chosen yet; no compiler is installed.
#  - Hard rule 6: the base image must be referenced by digest. Build with
#      docker build --build-arg BASE_IMAGE=<image>@sha256:<digest> packs/tech/ind880-c
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
RUN case "${BASE_IMAGE}" in *@sha256:*) ;; *) echo "BASE_IMAGE must be pinned by digest" >&2; exit 1 ;; esac
LABEL org.opencontainers.image.title="adlc-toolchain-ind880" \
      adlc.pack="ind880-c" \
      adlc.stub="true"
WORKDIR /workspace
# Non-root numeric user; the executor also runs it rootless with a read-only root FS (P0-WP4).
USER 65532:65532
