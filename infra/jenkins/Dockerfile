# Jenkins controller for the dev/CI stack (P0-WP6, FR-CI-001), configured as code (casc.yaml).
# Built by `pnpm dev:up` when COMPOSE_PROFILES includes "ci". Base image pinned by digest (images.env).
ARG JENKINS_IMAGE
FROM ${JENKINS_IMAGE}

USER root
# Optional CA certificates for a TLS-inspecting proxy (certs/README.md); none are committed.
COPY certs/ /tmp/extra-ca/
RUN for c in /tmp/extra-ca/*.crt; do \
      [ -f "$c" ] || continue; \
      keytool -importcert -noprompt -cacerts -storepass changeit -alias "extra-$(basename "$c" .crt)" -file "$c" >/dev/null; \
    done && rm -rf /tmp/extra-ca
USER jenkins

# Every plugin pinned, dependencies included (plugins.txt); --latest false: no dependency floats up.
COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt --latest false
COPY --chown=jenkins:jenkins casc.yaml /usr/share/jenkins/ref/casc.yaml
ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/ref/casc.yaml \
    JAVA_OPTS="-Djenkins.install.runSetupWizard=false"
